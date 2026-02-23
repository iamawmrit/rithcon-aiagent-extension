// agent.js handles planning and execution when Agent Mode is enabled.

const MAX_PLAN_STEPS = 20;
const MAX_TODOS = 12;
const MAX_SELECTOR_LENGTH = 320;
const MAX_FIELD_TEXT_LENGTH = 1200;
const MAX_REPLY_LENGTH = 2500;
const STEP_DELAY_MS = 120;

const LOW_RISK_ACTIONS = new Set([
    'ANALYZE_PAGE',
    'SCRAPE_PAGE',
    'VISUALIZE_PAGE',
    'GOOGLE_SEARCH',
    'SEARCH_YOUTUBE',
    'PLAY_MEDIA',
    'WAIT'
]);

const TAB_ACTIONS = new Set([
    'NAVIGATE',
    'SEARCH_YOUTUBE',
    'GOOGLE_SEARCH',
    'PLAY_MEDIA',
    'CLICK',
    'TYPE',
    'FILL_FORM',
    'ANALYZE_PAGE',
    'SCRAPE_PAGE',
    'VISUALIZE_PAGE',
    'OPEN_TAB',
    'SWITCH_TAB',
    'WAIT'
]);

const ALLOWED_ACTIONS = new Set([...TAB_ACTIONS, 'REPLY']);
const DIRECT_SITE_MAP = {
    facebook: 'https://www.facebook.com/',
    instagram: 'https://www.instagram.com/',
    youtube: 'https://www.youtube.com/',
    gmail: 'https://mail.google.com/',
    google: 'https://www.google.com/',
    twitter: 'https://x.com/',
    x: 'https://x.com/',
    linkedin: 'https://www.linkedin.com/',
    github: 'https://github.com/',
    reddit: 'https://www.reddit.com/'
};

window.processAgentCommand = async function (prompt, apiKey, provider, model, baseUrl, runContext = {}) {
    const runId = runContext.runId || `run-${Date.now()}`;
    const signal = runContext.signal;
    const shouldStop = typeof runContext.shouldStop === 'function'
        ? runContext.shouldStop
        : () => Boolean(signal && signal.aborted);

    const defaultTarget = inferDefaultTarget(prompt, runContext);

    assertNotStopped(shouldStop);
    window.updateAgentStatus('Analyzing intent...');
    window.appendActionLog(`[${runId}] Request received`);

    try {
        const tabSnapshot = await tryGetTabSnapshot(signal);
        const activeHost = getActiveHost(tabSnapshot);
        const pageContext = await tryGetPageContextIfNeeded(prompt, runId, signal);

        const deterministicPlan = maybeBuildDeterministicPlan(prompt, defaultTarget);
        const fastPlan = maybeBuildFastPlan(prompt, defaultTarget);
        let plan = [];

        if (deterministicPlan) {
            plan = sanitizePlan(deterministicPlan, defaultTarget);
            window.appendActionLog(`[${runId}] Using deterministic navigation plan`);
        } else if (fastPlan) {
            plan = sanitizePlan(fastPlan, defaultTarget);
            window.appendActionLog(`[${runId}] Using local fast plan`);
        } else {
            const systemPrompt = buildSystemPrompt(defaultTarget);
            const fullPrompt = buildPlanningPrompt(systemPrompt, prompt, tabSnapshot, pageContext);

            const rawPlanResponse = await window.generateChatResponse(
                fullPrompt,
                apiKey,
                provider,
                model,
                baseUrl,
                { signal }
            );
            assertNotStopped(shouldStop);

            const plannerOutput = parsePlannerResponse(rawPlanResponse);
            const todos = sanitizeTodos(plannerOutput.todos);

            if (plannerOutput.analysis) {
                window.appendMessage(`Analysis: ${plannerOutput.analysis}`, 'system-msg');
            }

            if (todos.length) {
                renderTodosPreview(todos);
            }

            plan = sanitizePlan(plannerOutput.plan, defaultTarget);

            if (!plan.length) {
                const todoActions = todos
                    .map(todo => todo.action)
                    .filter(action => action && typeof action === 'object');
                plan = sanitizePlan(todoActions, defaultTarget);
            }
        }

        if (!plan.length) {
            throw new Error('Planner returned an empty action plan.');
        }

        window.appendActionLog(`[${runId}] Plan generated with ${plan.length} step(s)`);
        renderPlanPreview(plan);

        let successCount = 0;
        let skippedCount = 0;
        let failureCount = 0;
        let currentHost = activeHost;

        for (let index = 0; index < plan.length; index++) {
            assertNotStopped(shouldStop);

            const step = plan[index];
            window.updateAgentStatus(`Step ${index + 1}/${plan.length}: ${step.action}`);
            window.appendActionLog(`Step ${index + 1}: ${formatStepSummary(step)}`);

            if (step.action === 'REPLY') {
                window.appendMessage(redactSensitiveText(step.message), 'bot-msg');
                successCount += 1;
                continue;
            }

            const riskInfo = classifyStepRisk(step, prompt, currentHost);
            if (riskInfo.level === 'high') {
                const approval = await requestApprovalIfNeeded(step, riskInfo, shouldStop);
                if (!approval.approved) {
                    window.appendActionLog(`Skipped ${step.action}: approval ${approval.reason || 'denied'}`);
                    skippedCount += 1;
                    continue;
                }
            }

            try {
                const response = await executeStepWithRecovery(step, runId, signal, shouldStop);
                logExecutionResult(step, response);
                renderStructuredResult(step, response);
                successCount += 1;

                const nextHost = getHostFromStep(step);
                if (nextHost) {
                    currentHost = nextHost;
                }
            } catch (error) {
                failureCount += 1;
                const remediation = buildRemediationMessage(step, error.message);
                window.appendActionLog(`Action failed: ${redactSensitiveText(error.message)}`);
                window.appendMessage(remediation, 'system-msg');
                break;
            }

            if (index < plan.length - 1) {
                await cancellableDelay(STEP_DELAY_MS, shouldStop, signal);
            }
        }

        window.appendMessage(
            `Run summary: ${successCount} completed, ${skippedCount} skipped, ${failureCount} failed.`,
            'system-msg'
        );
        window.updateAgentStatus('Agent ready', true);
    } catch (error) {
        const isAbort = isAbortError(error) || shouldStop();
        if (isAbort) {
            window.appendActionLog(`[${runId}] Execution stopped`);
            window.appendMessage('Process stopped.', 'system-msg');
            window.updateAgentStatus('Agent ready', true);
            return;
        }

        throw new Error(`Agent execution failed: ${error.message}`);
    }
};

window.formatAgentStepSummary = function (step) {
    return formatStepSummary(step);
};

async function tryGetTabSnapshot(signal) {
    try {
        return await sendRuntimeMessage({ type: 'GET_TAB_SNAPSHOT' }, signal);
    } catch (_error) {
        return null;
    }
}

function getActiveHost(tabSnapshot) {
    if (!tabSnapshot || !Array.isArray(tabSnapshot.tabs)) {
        return '';
    }

    const activeTab = tabSnapshot.tabs.find(tab => tab.active) || tabSnapshot.tabs[0];
    if (!activeTab || !activeTab.url) {
        return '';
    }

    try {
        return new URL(activeTab.url).hostname.toLowerCase();
    } catch (_error) {
        return '';
    }
}

async function tryGetPageContextIfNeeded(prompt, runId, signal) {
    const shouldFetchContext = /\b(analy[sz]e|visuali[sz]e|inspect|scrap|extract|summari[sz]e|login|log in|register|sign up|sign in|fill form|submit)\b/i.test(prompt);
    if (!shouldFetchContext) {
        return null;
    }

    try {
        window.appendActionLog(`[${runId}] Collecting current page context`);
        return await sendRuntimeMessage({ type: 'GET_PAGE_CONTEXT', runId }, signal);
    } catch (error) {
        window.appendActionLog(`[${runId}] Context fetch skipped: ${redactSensitiveText(error.message)}`);
        return null;
    }
}

function buildSystemPrompt(defaultTarget) {
    return `You are rithcon, a browser AI agent.
Generate ONLY valid JSON (no markdown).
Output format must be:
{
  "analysis": "short intent + strategy summary",
  "todos": [
    { "task": "what to do", "reason": "why", "action": { ...optional action object... } }
  ],
  "plan": [ ...action objects... ]
}

Allowed actions:
[
  { "action": "REPLY", "message": "..." },
  { "action": "NAVIGATE", "url": "https://...", "target": { "mode": "active|all|url_contains|domain|tab_id", "value": "optional" } },
  { "action": "OPEN_TAB", "url": "https://...", "active": false },
  { "action": "SWITCH_TAB", "tabId": 123 },
  { "action": "GOOGLE_SEARCH", "query": "...", "target": { "mode": "active|all" } },
  { "action": "SEARCH_YOUTUBE", "query": "...", "target": { "mode": "active|all" } },
  { "action": "PLAY_MEDIA", "target": { "mode": "active|all" } },
  { "action": "CLICK", "selector": "...", "text": "optional", "target": { "mode": "active|all|domain", "value": "optional" } },
  { "action": "TYPE", "selector": "...", "text": "...", "clear": true, "target": { "mode": "active|all|domain", "value": "optional" } },
  {
    "action": "FILL_FORM",
    "fields": [
      { "selector": "optional", "name": "optional", "label": "optional", "placeholder": "optional", "value": "required", "type": "optional" }
    ],
    "submit": true,
    "submitSelector": "optional",
    "target": { "mode": "active|all|domain", "value": "optional" }
  },
  { "action": "ANALYZE_PAGE", "includeText": true, "maxTextChars": 3000, "target": { "mode": "active|all|domain", "value": "optional" } },
  { "action": "VISUALIZE_PAGE", "target": { "mode": "active|all|domain", "value": "optional" } },
  { "action": "SCRAPE_PAGE", "maxChars": 5000, "target": { "mode": "active|all|domain", "value": "optional" } },
  { "action": "WAIT", "ms": 800 }
]

Rules:
1. Use browser actions whenever user asks to interact with websites.
2. For login/register requests, prefer: ANALYZE_PAGE -> FILL_FORM -> CLICK or submit.
3. For YouTube music requests, prefer SEARCH_YOUTUBE then PLAY_MEDIA.
4. For visual/inspection requests, use ANALYZE_PAGE and optionally VISUALIZE_PAGE.
5. Keep plans short, safe, and deterministic (max ${MAX_PLAN_STEPS} steps, max ${MAX_TODOS} todos).
6. Default target is ${JSON.stringify(defaultTarget)} unless user explicitly asks otherwise.
7. For every plan step, include a corresponding todo.
8. Never output markdown fences or prose.`;
}

function buildPlanningPrompt(systemPrompt, userPrompt, tabSnapshot, pageContext) {
    const tabContext = tabSnapshot && Array.isArray(tabSnapshot.tabs)
        ? tabSnapshot.tabs.slice(0, 12).map(tab => ({
            id: tab.id,
            active: tab.active,
            title: tab.title,
            url: tab.url
        }))
        : [];

    const pageData = pageContext && pageContext.data
        ? pageContext.data
        : null;

    const contextSections = [];
    if (tabContext.length) {
        contextSections.push(`Open tabs: ${safeJson(tabContext, 1800)}`);
    }
    if (pageData) {
        contextSections.push(`Current page context: ${safeJson(pageData, 3200)}`);
    }

    return `${systemPrompt}\n\nUser request: ${userPrompt}\n\n${contextSections.join('\n\n')}`;
}

function parsePlannerResponse(rawResponse) {
    const fallback = {
        analysis: '',
        todos: [],
        plan: [{
            action: 'REPLY',
            message: 'I could not parse a valid execution plan from the model output.'
        }]
    };

    if (!rawResponse || typeof rawResponse !== 'string') {
        return fallback;
    }

    let cleaned = rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    } else if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
        cleaned = cleaned.slice(firstBracket, lastBracket + 1);
    }

    try {
        const parsed = JSON.parse(cleaned);

        if (Array.isArray(parsed)) {
            return {
                analysis: '',
                todos: buildTodosFromPlan(parsed),
                plan: parsed
            };
        }

        if (parsed && typeof parsed === 'object') {
            const plan = Array.isArray(parsed.plan)
                ? parsed.plan
                : Array.isArray(parsed.actions)
                    ? parsed.actions
                    : Array.isArray(parsed.steps)
                        ? parsed.steps
                        : [];

            const todos = Array.isArray(parsed.todos)
                ? parsed.todos
                : buildTodosFromPlan(plan);

            const analysis = sanitizeText(
                typeof parsed.analysis === 'string'
                    ? parsed.analysis
                    : typeof parsed.summary === 'string'
                        ? parsed.summary
                        : '',
                700
            );

            return { analysis, todos, plan };
        }
    } catch (_error) {
        // fall through
    }

    return {
        analysis: '',
        todos: [],
        plan: [{
            action: 'REPLY',
            message: `I could not convert the plan to valid JSON. Raw planner output: ${cleaned.slice(0, 1000)}`
        }]
    };
}

function sanitizePlan(plan, defaultTarget) {
    if (!Array.isArray(plan)) {
        return [{ action: 'REPLY', message: 'Invalid plan format.' }];
    }

    const sanitized = [];
    for (const rawStep of plan.slice(0, MAX_PLAN_STEPS)) {
        if (!rawStep || typeof rawStep !== 'object') {
            continue;
        }

        const action = typeof rawStep.action === 'string'
            ? rawStep.action.trim().toUpperCase()
            : '';

        if (!ALLOWED_ACTIONS.has(action)) {
            continue;
        }

        const step = { action };
        if (TAB_ACTIONS.has(action)) {
            step.target = normalizeTarget(rawStep.target, defaultTarget);
        }

        switch (action) {
            case 'REPLY': {
                const message = sanitizeText(rawStep.message, MAX_REPLY_LENGTH);
                if (!message) {
                    continue;
                }
                step.message = message;
                break;
            }
            case 'NAVIGATE':
            case 'OPEN_TAB': {
                const url = sanitizeUrl(rawStep.url);
                if (!url) {
                    continue;
                }
                step.url = url;
                if (action === 'OPEN_TAB') {
                    step.active = Boolean(rawStep.active);
                }
                break;
            }
            case 'SWITCH_TAB': {
                const tabId = Number(rawStep.tabId);
                if (!Number.isFinite(tabId) || tabId <= 0) {
                    continue;
                }
                step.tabId = tabId;
                break;
            }
            case 'GOOGLE_SEARCH':
            case 'SEARCH_YOUTUBE': {
                const query = sanitizeText(rawStep.query, 280);
                if (!query) {
                    continue;
                }
                step.query = query;
                break;
            }
            case 'PLAY_MEDIA':
            case 'VISUALIZE_PAGE':
                break;
            case 'CLICK': {
                const selector = sanitizeSelector(rawStep.selector);
                const text = sanitizeText(rawStep.text, 180);
                if (!selector && !text) {
                    continue;
                }
                if (selector) step.selector = selector;
                if (text) step.text = text;
                break;
            }
            case 'TYPE': {
                const selector = sanitizeSelector(rawStep.selector);
                const text = sanitizeText(rawStep.text, MAX_FIELD_TEXT_LENGTH);
                if (!selector || !text) {
                    continue;
                }
                step.selector = selector;
                step.text = text;
                step.clear = rawStep.clear !== false;
                break;
            }
            case 'FILL_FORM': {
                if (!Array.isArray(rawStep.fields)) {
                    continue;
                }
                const fields = rawStep.fields
                    .map(sanitizeFormField)
                    .filter(Boolean)
                    .slice(0, 12);

                if (!fields.length) {
                    continue;
                }

                step.fields = fields;
                step.submit = Boolean(rawStep.submit);
                const submitSelector = sanitizeSelector(rawStep.submitSelector);
                if (submitSelector) {
                    step.submitSelector = submitSelector;
                }
                break;
            }
            case 'ANALYZE_PAGE': {
                step.includeText = rawStep.includeText !== false;
                step.maxTextChars = clamp(Number(rawStep.maxTextChars) || 3000, 600, 9000);
                break;
            }
            case 'SCRAPE_PAGE': {
                step.maxChars = clamp(Number(rawStep.maxChars) || 5000, 800, 15000);
                break;
            }
            case 'WAIT': {
                step.ms = clamp(Number(rawStep.ms) || 800, 80, 20000);
                break;
            }
            default:
                continue;
        }

        sanitized.push(step);
    }

    if (!sanitized.length) {
        return [{ action: 'REPLY', message: 'I could not build a safe action plan for this request.' }];
    }

    return sanitized;
}

function sanitizeFormField(field) {
    if (!field || typeof field !== 'object') {
        return null;
    }

    const value = sanitizeText(field.value, MAX_FIELD_TEXT_LENGTH);
    if (!value) {
        return null;
    }

    const result = { value };

    const selector = sanitizeSelector(field.selector);
    const name = sanitizeText(field.name, 120);
    const label = sanitizeText(field.label, 120);
    const placeholder = sanitizeText(field.placeholder, 120);
    const type = sanitizeText(field.type, 32);

    if (selector) result.selector = selector;
    if (name) result.name = name;
    if (label) result.label = label;
    if (placeholder) result.placeholder = placeholder;
    if (type) result.type = type;

    return result;
}

function inferDefaultTarget(prompt, runContext) {
    if (runContext && runContext.explicitTarget === true && runContext.defaultTarget) {
        return normalizeTarget(runContext.defaultTarget, { mode: 'active' });
    }

    const domainPhraseMatch = String(prompt || '').match(/\bon\s+([a-z0-9.-]+\.[a-z]{2,})\s+tabs?\b/i);
    if (domainPhraseMatch) {
        return { mode: 'domain', value: domainPhraseMatch[1].toLowerCase() };
    }

    if (/\b(all tabs?|every tab|each tab|across tabs|on all open tabs)\b/i.test(prompt)) {
        return { mode: 'all' };
    }

    return { mode: 'active' };
}

function normalizeTarget(target, fallback) {
    const fallbackTarget = typeof fallback === 'object' && fallback ? fallback : { mode: 'active' };

    if (!target) {
        return fallbackTarget;
    }

    if (typeof target === 'string') {
        const normalized = target.toLowerCase().trim();
        if (normalized === 'all') return { mode: 'all' };
        if (normalized === 'active' || normalized === 'current') return { mode: 'active' };
        if (normalized.includes('.') && !normalized.includes(' ')) return { mode: 'domain', value: normalized };
        return fallbackTarget;
    }

    if (typeof target !== 'object') {
        return fallbackTarget;
    }

    const mode = String(target.mode || '').toLowerCase();
    if (mode === 'all' || mode === 'active') {
        return { mode };
    }

    if (mode === 'tab_id') {
        const tabId = Number(target.value ?? target.tabId);
        if (Number.isFinite(tabId) && tabId > 0) {
            return { mode: 'tab_id', value: tabId };
        }
    }

    if (mode === 'url_contains' || mode === 'domain') {
        const value = sanitizeText(target.value, 120).toLowerCase();
        if (value) {
            return { mode, value };
        }
    }

    return fallbackTarget;
}

function sanitizeSelector(selector) {
    if (typeof selector !== 'string') {
        return '';
    }
    const trimmed = selector.trim();
    if (!trimmed || trimmed.length > MAX_SELECTOR_LENGTH) {
        return '';
    }
    return trimmed;
}

function sanitizeText(text, maxLength) {
    if (typeof text !== 'string') {
        return '';
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return '';
    }
    return trimmed.slice(0, maxLength);
}

function sanitizeUrl(input) {
    if (typeof input !== 'string') {
        return '';
    }

    const trimmed = input.trim();
    if (!trimmed) {
        return '';
    }

    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return '';
        }
        return parsed.toString();
    } catch (_error) {
        return '';
    }
}

function renderPlanPreview(plan) {
    const lines = plan.slice(0, 6).map((step, index) => `${index + 1}. ${formatStepSummary(step)}`);
    if (plan.length > 6) {
        lines.push(`... +${plan.length - 6} more step(s)`);
    }
    window.appendMessage(`Plan:\n${lines.join('\n')}`, 'system-msg');
}

function renderTodosPreview(todos) {
    const lines = todos
        .slice(0, 6)
        .map((todo, index) => `${index + 1}. ${todo.task}${todo.reason ? ` (${todo.reason})` : ''}`);
    if (todos.length > 6) {
        lines.push(`... +${todos.length - 6} more todo(s)`);
    }
    window.appendMessage(`Todos:\n${lines.join('\n')}`, 'system-msg');
}

function sanitizeTodos(rawTodos) {
    if (!Array.isArray(rawTodos)) {
        return [];
    }

    const todos = [];
    for (const rawTodo of rawTodos.slice(0, MAX_TODOS)) {
        if (!rawTodo) {
            continue;
        }

        if (typeof rawTodo === 'string') {
            const task = sanitizeText(rawTodo, 240);
            if (task) {
                todos.push({ task, reason: '', action: null });
            }
            continue;
        }

        if (typeof rawTodo !== 'object') {
            continue;
        }

        const task = sanitizeText(
            rawTodo.task || rawTodo.title || rawTodo.todo || rawTodo.step || '',
            240
        );
        if (!task) {
            continue;
        }

        const reason = sanitizeText(rawTodo.reason || rawTodo.why || '', 240);
        const action = rawTodo.action && typeof rawTodo.action === 'object'
            ? rawTodo.action
            : null;
        todos.push({ task, reason, action });
    }

    return todos;
}

function buildTodosFromPlan(plan) {
    if (!Array.isArray(plan)) {
        return [];
    }

    return plan.slice(0, MAX_TODOS).map((step, index) => ({
        task: `Step ${index + 1}: ${formatStepSummary(step)}`,
        reason: '',
        action: step
    }));
}

function classifyStepRisk(step, prompt, currentHost) {
    const reasons = [];
    const action = step.action;

    if (LOW_RISK_ACTIONS.has(action)) {
        return { level: 'low', reasons };
    }

    if (action === 'NAVIGATE' || action === 'OPEN_TAB') {
        const targetHost = getHostFromStep(step);
        if (targetHost && currentHost && targetHost !== currentHost) {
            reasons.push(`navigates across domains (${currentHost} -> ${targetHost})`);
        }
        if (reasons.length) {
            return { level: 'high', reasons, timeoutMs: 25000 };
        }
        return { level: 'medium', reasons: ['navigation action'] };
    }

    if (action === 'FILL_FORM') {
        if (step.submit) {
            reasons.push('submits a form');
        }
        if (containsAuthIntent(prompt)) {
            reasons.push('authentication flow');
        }
        if (containsSensitiveField(step)) {
            reasons.push('contains sensitive field values');
        }
        return { level: reasons.length ? 'high' : 'medium', reasons, timeoutMs: 30000 };
    }

    if (action === 'CLICK') {
        const clickText = `${step.selector || ''} ${step.text || ''}`.toLowerCase();
        if (/submit|sign\s?in|login|register|sign\s?up|checkout|pay|continue/i.test(clickText)) {
            reasons.push('click may trigger submit/auth/payment');
            return { level: 'high', reasons, timeoutMs: 25000 };
        }
        return { level: 'medium', reasons: ['direct page interaction'] };
    }

    if (action === 'TYPE') {
        if (containsAuthIntent(prompt)) {
            reasons.push('typing during authentication flow');
            return { level: 'high', reasons, timeoutMs: 25000 };
        }
        return { level: 'medium', reasons: ['direct page interaction'] };
    }

    return { level: 'medium', reasons: ['interactive action'] };
}

function containsAuthIntent(text) {
    return /\b(login|log in|sign in|register|sign up|password|otp|verification)\b/i.test(String(text || ''));
}

function containsSensitiveField(step) {
    if (!Array.isArray(step.fields)) {
        return false;
    }
    return step.fields.some(field => {
        const descriptor = `${field.name || ''} ${field.label || ''} ${field.type || ''} ${field.placeholder || ''}`.toLowerCase();
        return /password|passcode|token|otp|secret|api key|apikey/i.test(descriptor);
    });
}

async function requestApprovalIfNeeded(step, riskInfo, shouldStop) {
    if (shouldStop()) {
        return { approved: false, reason: 'canceled' };
    }

    if (typeof window.requestActionApproval !== 'function') {
        return { approved: true, reason: 'ui-unavailable' };
    }

    const safeRiskInfo = {
        level: riskInfo.level,
        reasons: (riskInfo.reasons || []).map(redactSensitiveText),
        timeoutMs: riskInfo.timeoutMs || 20000
    };

    const result = await window.requestActionApproval(safeStepForLogging(step), safeRiskInfo);
    return result && typeof result === 'object'
        ? result
        : { approved: false, reason: 'invalid-response' };
}

async function executeStepWithRecovery(step, runId, signal, shouldStop) {
    try {
        return await sendCommandToBackground(step, runId, signal);
    } catch (error) {
        if (!shouldAttemptRecovery(step, error.message)) {
            throw error;
        }

        assertNotStopped(shouldStop);
        window.appendActionLog(`Recovery: re-analyzing page before retrying ${step.action}`);

        try {
            await sendCommandToBackground({
                action: 'ANALYZE_PAGE',
                includeText: false,
                maxTextChars: 1200,
                target: step.target
            }, runId, signal);
        } catch (_ignored) {
            // Continue to retry original step even if analysis fails.
        }

        assertNotStopped(shouldStop);
        return await sendCommandToBackground(step, runId, signal);
    }
}

function shouldAttemptRecovery(step, message) {
    if (!step || !['CLICK', 'TYPE', 'FILL_FORM'].includes(step.action)) {
        return false;
    }

    const normalized = String(message || '').toLowerCase();
    return normalized.includes('element not found')
        || normalized.includes('could not find element')
        || normalized.includes('input not found')
        || normalized.includes('no form fields matched');
}

function buildRemediationMessage(step, message) {
    const safeMessage = redactSensitiveText(message);
    const hints = {
        CLICK: 'Try providing a more specific selector or button text.',
        TYPE: 'Try giving a precise input selector like #email or input[name="email"].',
        FILL_FORM: 'Try adding field labels/names exactly as shown on the form.'
    };

    const hint = hints[step.action] || 'Try a more specific command for this step.';
    return `I could not complete ${step.action}: ${safeMessage}. ${hint}`;
}

function formatStepSummary(step) {
    const safeStep = safeStepForLogging(step);
    switch (safeStep.action) {
        case 'NAVIGATE':
        case 'OPEN_TAB':
            return `${safeStep.action} ${safeStep.url}`;
        case 'GOOGLE_SEARCH':
        case 'SEARCH_YOUTUBE':
            return `${safeStep.action} "${safeStep.query}"`;
        case 'CLICK':
            return `${safeStep.action} ${safeStep.selector || `text:${safeStep.text}`}`;
        case 'TYPE':
            return `${safeStep.action} ${safeStep.selector}`;
        case 'FILL_FORM':
            return `${safeStep.action} (${safeStep.fields.length} field${safeStep.fields.length === 1 ? '' : 's'})${safeStep.submit ? ' + submit' : ''}`;
        case 'WAIT':
            return `${safeStep.action} ${safeStep.ms}ms`;
        case 'SWITCH_TAB':
            return `${safeStep.action} #${safeStep.tabId}`;
        default:
            return safeStep.action;
    }
}

function safeStepForLogging(step) {
    if (!step || typeof step !== 'object') {
        return step;
    }

    const clone = { ...step };

    if (typeof clone.query === 'string') {
        clone.query = redactSensitiveText(clone.query);
    }
    if (typeof clone.url === 'string') {
        clone.url = redactSensitiveText(clone.url);
    }
    if (typeof clone.text === 'string') {
        clone.text = redactSensitiveText(clone.text);
    }

    if (Array.isArray(clone.fields)) {
        clone.fields = clone.fields.map(field => {
            const fieldClone = { ...field };
            const descriptor = `${fieldClone.name || ''} ${fieldClone.label || ''} ${fieldClone.type || ''}`.toLowerCase();
            if (fieldClone.value && /password|pass|token|secret|api key|apikey|otp/i.test(descriptor)) {
                fieldClone.value = '[REDACTED]';
            } else if (fieldClone.value) {
                fieldClone.value = redactSensitiveText(fieldClone.value);
            }
            return fieldClone;
        });
    }

    return clone;
}

function redactSensitiveText(text) {
    if (typeof text !== 'string') {
        return text;
    }

    let value = text;

    value = value.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***$2');
    value = value.replace(/(password|pass|token|apikey|api[_-]?key|secret)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
    value = value.replace(/\b[A-Za-z0-9_-]{24,}\b/g, (token) => {
        if (/^(https?|chrome|edge|brave)$/i.test(token)) {
            return token;
        }
        return `${token.slice(0, 4)}***${token.slice(-2)}`;
    });

    return value;
}

function logExecutionResult(step, response) {
    const durationMs = Number(response.durationMs) || 0;
    if (!Array.isArray(response.results)) {
        window.appendActionLog(`Completed ${step.action} in ${durationMs}ms`);
        return;
    }

    const successCount = response.results.filter(result => result.status === 'success').length;
    window.appendActionLog(`${step.action}: ${successCount}/${response.results.length} tab(s) succeeded in ${durationMs}ms`);

    response.results
        .filter(result => result.status !== 'success')
        .slice(0, 4)
        .forEach(result => {
            window.appendActionLog(`Tab ${result.tabId}: ${redactSensitiveText(result.error || 'unknown error')}`);
        });
}

function renderStructuredResult(step, response) {
    if (!Array.isArray(response.results)) {
        return;
    }

    if (step.action === 'ANALYZE_PAGE') {
        response.results
            .filter(result => result.status === 'success' && result.data)
            .forEach(result => {
                window.appendMessage(formatAnalyzeMessage(result), 'system-msg');
            });
    }

    if (step.action === 'SCRAPE_PAGE') {
        response.results
            .filter(result => result.status === 'success' && result.data && typeof result.data.text === 'string')
            .forEach(result => {
                const snippet = redactSensitiveText(result.data.text.slice(0, 650));
                window.appendMessage(`Scraped (${result.title || `Tab ${result.tabId}`}):\n${snippet}`, 'system-msg');
            });
    }
}

function formatAnalyzeMessage(result) {
    const data = result.data;
    const lines = [
        `Analysis (${result.title || `Tab ${result.tabId}`}):`,
        `URL: ${data.url || result.url || 'N/A'}`,
        `Title: ${data.title || 'N/A'}`,
        `Forms: ${Array.isArray(data.forms) ? data.forms.length : 0}`,
        `Buttons: ${Array.isArray(data.buttons) ? data.buttons.length : 0}`,
        `Links: ${Array.isArray(data.links) ? data.links.length : 0}`
    ];

    if (Array.isArray(data.loginHints) && data.loginHints.length) {
        lines.push(`Login hints: ${data.loginHints.slice(0, 3).join(', ')}`);
    }
    if (data.textSample) {
        lines.push(`Sample: ${redactSensitiveText(String(data.textSample).slice(0, 220))}...`);
    }

    return lines.join('\n');
}

function sendCommandToBackground(planStep, runId, signal) {
    return sendRuntimeMessage({ type: 'EXECUTE_AGENT_PLAN', runId, plan: planStep }, signal);
}

function sendRuntimeMessage(payload, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(createAbortError());
            return;
        }

        const abortHandler = () => reject(createAbortError());
        if (signal) {
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        chrome.runtime.sendMessage(payload, (response) => {
            if (signal) {
                signal.removeEventListener('abort', abortHandler);
            }

            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            if (response && response.status === 'error') {
                reject(new Error(response.error || 'Unknown execution error.'));
                return;
            }

            resolve(response || { status: 'success' });
        });
    });
}

function assertNotStopped(shouldStop) {
    if (shouldStop()) {
        throw createAbortError();
    }
}

function createAbortError() {
    const error = new Error('Request canceled');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || /aborted|canceled|cancelled/i.test(error.message)));
}

async function cancellableDelay(ms, shouldStop, signal) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        assertNotStopped(shouldStop);
        if (signal && signal.aborted) {
            throw createAbortError();
        }
        await new Promise(resolve => setTimeout(resolve, 40));
    }
}

function safeJson(value, maxLength) {
    try {
        return JSON.stringify(value).slice(0, maxLength);
    } catch (_error) {
        return '[]';
    }
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function maybeBuildFastPlan(prompt, defaultTarget) {
    if (typeof prompt !== 'string') {
        return null;
    }

    const normalizedPrompt = prompt.toLowerCase();
    const hasAuthIntent = /\b(register|sign up|signup|login|log in|sign in)\b/i.test(normalizedPrompt);
    const urlMatch = prompt.match(/https?:\/\/[^\s)]+/i);
    const url = urlMatch ? sanitizeUrl(urlMatch[0]) : '';

    if (hasAuthIntent && url) {
        const details = extractAuthDetails(prompt);
        return [
            {
                action: 'NAVIGATE',
                url,
                target: defaultTarget
            },
            {
                action: 'ANALYZE_PAGE',
                includeText: true,
                maxTextChars: 2500,
                target: defaultTarget
            },
            {
                action: 'FILL_FORM',
                fields: [
                    { label: 'email', name: 'email', type: 'email', value: details.email },
                    { label: 'username', name: 'username', type: 'text', value: details.username },
                    { label: 'password', name: 'password', type: 'password', value: details.password },
                    { label: 'confirm password', name: 'confirm password', type: 'password', value: details.password }
                ],
                submit: true,
                target: defaultTarget
            }
        ];
    }

    return null;
}

function maybeBuildDeterministicPlan(prompt, defaultTarget) {
    if (typeof prompt !== 'string') {
        return null;
    }

    const normalizedPrompt = prompt.toLowerCase();
    const hasNavigationIntent = /\b(go to|goto|goes to|open|navigate to|visit|take me to)\b/i.test(normalizedPrompt);
    const hasMediaIntent = /\b(play|music|song|playlist|youtube search|search youtube|video)\b/i.test(normalizedPrompt);

    if (!hasNavigationIntent || hasMediaIntent) {
        return null;
    }

    const resolvedUrl = resolveNavigationUrl(prompt);
    if (!resolvedUrl) {
        return null;
    }

    return [{
        action: 'NAVIGATE',
        url: resolvedUrl,
        target: defaultTarget
    }];
}

function resolveNavigationUrl(prompt) {
    if (typeof prompt !== 'string') {
        return '';
    }

    const explicitUrlMatch = prompt.match(/https?:\/\/[^\s)]+/i);
    if (explicitUrlMatch) {
        return sanitizeUrl(explicitUrlMatch[0]);
    }

    const domainMatch = prompt.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[^\s]*)?\b/i);
    if (domainMatch) {
        const domain = domainMatch[0];
        return sanitizeUrl(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);
    }

    const normalizedPrompt = prompt.toLowerCase();
    for (const [keyword, url] of Object.entries(DIRECT_SITE_MAP)) {
        const keywordRegex = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
        if (keywordRegex.test(normalizedPrompt)) {
            return url;
        }
    }

    return '';
}

function extractAuthDetails(prompt) {
    const email = extractPromptValue(prompt, /(email|e-mail)\s*(?:is|=|:)?\s*([^\s,;]+)/i);
    const passwordRaw = extractPromptValue(prompt, /(password|pass)\s*(?:is|=|:)?\s*([^\s,;]+)/i);
    const username = extractPromptValue(prompt, /(username|user)\s*(?:is|=|:)?\s*([^\s,;]+)/i);

    const wantsRandomPassword = /\b(password|pass)\s+random\b/i.test(prompt) || /\brandom password\b/i.test(prompt);
    const wantsRandomEmail = /\b(email)\s+random\b/i.test(prompt) || /\brandom email\b/i.test(prompt);

    const safeEmail = (email && !wantsRandomEmail)
        ? email
        : `user${Date.now().toString().slice(-6)}@example.com`;

    const safePassword = (passwordRaw && !wantsRandomPassword && !/^random$/i.test(passwordRaw))
        ? passwordRaw
        : generateRandomPassword();

    const safeUsername = username || safeEmail.split('@')[0];

    return {
        email: safeEmail,
        password: safePassword,
        username: safeUsername
    };
}

function extractPromptValue(prompt, regex) {
    const match = prompt.match(regex);
    if (!match || !match[2]) {
        return '';
    }
    return String(match[2]).trim().replace(/^["']|["']$/g, '');
}

function generateRandomPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    let password = '';
    for (let i = 0; i < 12; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHostFromStep(step) {
    if (!step || !step.url) {
        return '';
    }
    try {
        return new URL(step.url).hostname.toLowerCase();
    } catch (_error) {
        return '';
    }
}
