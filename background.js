// The background service worker handles extension orchestration across tabs.

const RUN_STATES = new Map();
const CONTENT_ACTIONS = new Set([
    'PLAY_MEDIA',
    'CLICK',
    'TYPE',
    'FILL_FORM',
    'ANALYZE_PAGE',
    'SCRAPE_PAGE',
    'VISUALIZE_PAGE'
]);

const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'gemini-1.5-flash',
    provider: 'gemini',
    baseUrl: '',
    agentModeEnabled: false,
    services: {
        youtube: true,
        google: true
    }
};

chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(async () => {
    const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    const merged = {
        ...DEFAULT_SETTINGS,
        ...existing,
        services: {
            ...DEFAULT_SETTINGS.services,
            ...(existing.services || {})
        }
    };
    await chrome.storage.local.set(merged);
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    (async () => {
        switch (request.type) {
            case 'EXECUTE_AGENT_PLAN':
                return await executeAgentPlan(request.plan, request.runId);
            case 'CANCEL_AGENT_RUN':
                return cancelAgentRun(request.runId);
            case 'GET_PAGE_CONTEXT':
                return await getActivePageContext(request.runId);
            case 'GET_TAB_SNAPSHOT':
                return await getTabSnapshot();
            default:
                return { status: 'error', error: `Unsupported message type: ${request.type}` };
        }
    })()
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ status: 'error', error: error.message }));

    return true;
});

async function executeAgentPlan(rawPlan, runId = `run-${Date.now()}`) {
    if (!rawPlan || typeof rawPlan !== 'object') {
        throw new Error('Invalid plan step.');
    }

    const action = normalizeAction(rawPlan.action);
    if (!action) {
        throw new Error('Plan action is missing.');
    }

    setRunState(runId, { canceled: false });
    throwIfCanceled(runId);

    const start = Date.now();
    const plan = { ...rawPlan, action };

    if (action === 'WAIT') {
        const waitMs = clamp(Number(plan.ms) || 800, 80, 20000);
        await waitWithCancellation(waitMs, runId);
        return {
            status: 'success',
            durationMs: Date.now() - start,
            results: [{ status: 'success', detail: `Waited ${waitMs}ms` }]
        };
    }

    if (action === 'OPEN_TAB') {
        const url = normalizeHttpUrl(plan.url);
        const tab = await chrome.tabs.create({ url, active: Boolean(plan.active) });
        return {
            status: 'success',
            durationMs: Date.now() - start,
            results: [{
                status: 'success',
                detail: `Opened new tab: ${url}`,
                tabId: tab.id,
                title: tab.title || '',
                url: tab.url || ''
            }]
        };
    }

    if (action === 'SWITCH_TAB') {
        const targetTabId = Number(plan.tabId);
        if (!Number.isFinite(targetTabId) || targetTabId <= 0) {
            throw new Error('SWITCH_TAB requires a valid tabId.');
        }
        await chrome.tabs.update(targetTabId, { active: true });
        return {
            status: 'success',
            durationMs: Date.now() - start,
            results: [{ status: 'success', detail: `Switched to tab #${targetTabId}`, tabId: targetTabId }]
        };
    }

    const tabs = await resolveTargetTabs(plan.target);
    if (!tabs.length) {
        throw new Error('No matching tabs found for this action.');
    }

    const results = await Promise.all(tabs.map(tab => executeActionOnTab(tab, plan, runId)));
    const successCount = results.filter(result => result.status === 'success').length;
    const durationMs = Date.now() - start;

    if (successCount === 0) {
        const firstError = results.find(result => result.error)?.error || 'Failed on all tabs.';
        return { status: 'error', error: firstError, durationMs, results };
    }

    return { status: 'success', durationMs, results };
}

function cancelAgentRun(runId) {
    if (!runId) {
        return { status: 'error', error: 'runId is required for cancellation.' };
    }
    setRunState(runId, { canceled: true });
    return { status: 'success', detail: `Run ${runId} marked as canceled.` };
}

async function getActivePageContext(runId = `ctx-${Date.now()}`) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
        throw new Error('No active tab found.');
    }

    if (isRestrictedUrl(tab.url || '')) {
        throw new Error('Cannot inspect browser-internal pages. Open a normal website tab and try again.');
    }

    const result = await executeActionOnTab(tab, {
        action: 'ANALYZE_PAGE',
        includeText: true,
        maxTextChars: 3000
    }, runId);

    if (result.status !== 'success') {
        throw new Error(result.error || 'Could not analyze the current page.');
    }

    return {
        status: 'success',
        data: result.data,
        tab: {
            id: tab.id,
            title: tab.title || '',
            url: tab.url || ''
        }
    };
}

async function getTabSnapshot() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return {
        status: 'success',
        tabs: tabs.map(tab => ({
            id: tab.id,
            active: Boolean(tab.active),
            title: (tab.title || '').slice(0, 120),
            url: sanitizeTabUrl(tab.url || '')
        }))
    };
}

async function executeActionOnTab(tab, plan, runId) {
    const safeTab = {
        tabId: tab.id,
        title: tab.title || '',
        url: tab.url || ''
    };

    try {
        throwIfCanceled(runId);
        const detail = await runTabAction(tab, plan, runId);
        return {
            status: 'success',
            ...safeTab,
            detail: detail.detail || detail,
            data: detail.data
        };
    } catch (error) {
        return {
            status: 'error',
            ...safeTab,
            error: error.message
        };
    }
}

async function runTabAction(tab, plan, runId) {
    if (!tab.id) {
        throw new Error('Invalid tab target.');
    }

    throwIfCanceled(runId);
    const action = normalizeAction(plan.action);

    switch (action) {
        case 'NAVIGATE': {
            const url = normalizeHttpUrl(plan.url);
            await chrome.tabs.update(tab.id, { url });
            await waitForTabReady(tab.id, runId, 4500);
            return { detail: `Navigated to ${url}` };
        }
        case 'GOOGLE_SEARCH': {
            const query = String(plan.query || '').trim();
            if (!query) throw new Error('GOOGLE_SEARCH requires a query.');
            const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
            await chrome.tabs.update(tab.id, { url });
            await waitForTabReady(tab.id, runId, 4500);
            return { detail: `Searching Google for "${query}"` };
        }
        case 'SEARCH_YOUTUBE': {
            const query = String(plan.query || '').trim();
            if (!query) throw new Error('SEARCH_YOUTUBE requires a query.');
            const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
            await chrome.tabs.update(tab.id, { url });
            await waitForTabReady(tab.id, runId, 4500);
            return { detail: `Searching YouTube for "${query}"` };
        }
        default: {
            if (!CONTENT_ACTIONS.has(action)) {
                throw new Error(`Unsupported action "${action}"`);
            }
            return await runContentAction(tab.id, plan, runId);
        }
    }
}

async function runContentAction(tabId, plan, runId) {
    const maxAttempts = 8;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        throwIfCanceled(runId);

        try {
            const tab = await waitForTabReady(tabId, runId, 3800);
            const tabUrl = tab.pendingUrl || tab.url || '';
            if (isRestrictedUrl(tabUrl)) {
                throw new Error('Cannot automate browser-internal pages. Open a regular website tab and retry.');
            }

            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            });

            throwIfCanceled(runId);
            const response = await sendMessageToTab(tabId, {
                type: 'RUN_ACTION',
                runId,
                plan
            });

            if (!response || response.status !== 'success') {
                throw new Error(response?.error || 'Content script returned an error.');
            }

            return {
                detail: response.detail || `${plan.action} completed`,
                data: response.data
            };
        } catch (error) {
            lastError = error;
            if (!isRetryableContentError(error.message) || attempt === maxAttempts) {
                throw error;
            }
            await delay(180);
        }
    }

    throw lastError || new Error('Unable to run content action.');
}

function sendMessageToTab(tabId, payload, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for tab ${tabId}.`));
        }, timeoutMs);

        chrome.tabs.sendMessage(tabId, payload, (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}

async function resolveTargetTabs(target) {
    const normalizedTarget = normalizeTarget(target);

    if (normalizedTarget.mode === 'tab_id') {
        const tab = await chrome.tabs.get(normalizedTarget.value);
        return tab ? [tab] : [];
    }

    if (normalizedTarget.mode === 'active') {
        return await chrome.tabs.query({ active: true, currentWindow: true });
    }

    const tabs = await chrome.tabs.query({ currentWindow: true });

    if (normalizedTarget.mode === 'all') {
        return tabs;
    }

    if (normalizedTarget.mode === 'url_contains') {
        const needle = normalizedTarget.value.toLowerCase();
        return tabs.filter(tab => (tab.url || '').toLowerCase().includes(needle));
    }

    if (normalizedTarget.mode === 'domain') {
        const needle = normalizedTarget.value.toLowerCase();
        return tabs.filter(tab => {
            try {
                return new URL(tab.url || '').hostname.toLowerCase().includes(needle);
            } catch (_error) {
                return false;
            }
        });
    }

    return await chrome.tabs.query({ active: true, currentWindow: true });
}

function normalizeTarget(target) {
    if (!target) return { mode: 'active' };

    if (typeof target === 'string') {
        const value = target.toLowerCase().trim();
        if (value === 'all') return { mode: 'all' };
        if (value === 'active' || value === 'current') return { mode: 'active' };
        if (value.includes('.') && !value.includes(' ')) return { mode: 'domain', value };
        return { mode: 'active' };
    }

    if (typeof target !== 'object') {
        return { mode: 'active' };
    }

    const mode = String(target.mode || '').toLowerCase();
    if (mode === 'all' || mode === 'active') {
        return { mode };
    }

    if (mode === 'tab_id') {
        const value = Number(target.value);
        if (Number.isFinite(value) && value > 0) {
            return { mode: 'tab_id', value };
        }
    }

    if ((mode === 'domain' || mode === 'url_contains') && typeof target.value === 'string') {
        const value = target.value.trim();
        if (value) {
            return { mode, value };
        }
    }

    return { mode: 'active' };
}

function normalizeAction(action) {
    if (typeof action !== 'string') return '';
    return action.trim().toUpperCase();
}

function normalizeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string') {
        throw new Error('A valid URL is required.');
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
        throw new Error('URL cannot be empty.');
    }

    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch (_error) {
        throw new Error(`Invalid URL: ${rawUrl}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https URLs are allowed.');
    }

    return parsed.toString();
}

function sanitizeTabUrl(url) {
    if (!url) return '';
    if (isRestrictedUrl(url)) return 'restricted://';
    return String(url).slice(0, 220);
}

function isRestrictedUrl(url) {
    return /^chrome:\/\//i.test(url)
        || /^edge:\/\//i.test(url)
        || /^brave:\/\//i.test(url)
        || /^about:/i.test(url)
        || /^chrome-extension:\/\//i.test(url)
        || /^view-source:/i.test(url)
        || /^devtools:\/\//i.test(url);
}

function setRunState(runId, partialState) {
    if (!runId) return;
    const existing = RUN_STATES.get(runId) || { canceled: false };
    RUN_STATES.set(runId, {
        ...existing,
        ...partialState,
        updatedAt: Date.now()
    });
}

function throwIfCanceled(runId) {
    if (!runId) return;
    const state = RUN_STATES.get(runId);
    if (state && state.canceled) {
        throw new Error(`Run ${runId} was canceled.`);
    }
}

async function waitWithCancellation(ms, runId) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        throwIfCanceled(runId);
        await delay(60);
    }
}

async function waitForTabReady(tabId, runId, timeoutMs = 4500) {
    const start = Date.now();
    let latestTab = await chrome.tabs.get(tabId);

    while (Date.now() - start < timeoutMs) {
        throwIfCanceled(runId);
        latestTab = await chrome.tabs.get(tabId);

        const status = latestTab.status || 'complete';
        const currentUrl = latestTab.pendingUrl || latestTab.url || '';
        if (isRestrictedUrl(currentUrl)) {
            return latestTab;
        }

        if (status === 'complete') {
            return latestTab;
        }

        await delay(120);
    }

    return latestTab;
}

function isRetryableContentError(message) {
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('receiving end does not exist')
        || normalized.includes('frame with id 0 is showing error page')
        || normalized.includes('cannot access contents of the page')
        || normalized.includes('must request permission')
        || normalized.includes('timed out waiting for tab')
        || normalized.includes('cannot automate browser-internal pages');
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
