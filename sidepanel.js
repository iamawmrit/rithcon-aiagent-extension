// DOM Elements
const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const agentModeToggle = document.getElementById('agent-mode-toggle');
const modeLabels = document.querySelectorAll('.mode-label');
const agentStatusBar = document.getElementById('agent-status-bar');
const agentStatusText = document.getElementById('agent-status-text');

// Settings Elements
const settingsBtn = document.getElementById('settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const providerCards = document.querySelectorAll('.provider-card');
const customProviderBtn = document.getElementById('custom-provider-btn');
const baseUrlGroup = document.getElementById('base-url-group');
const baseUrlInput = document.getElementById('base-url-input');
const modelInput = document.getElementById('model-input');
const apiKeyInput = document.getElementById('api-key-input');
const saveStatus = document.getElementById('save-status');
const serviceYoutube = document.getElementById('service-youtube');
const serviceGoogle = document.getElementById('service-google');
const selectedProviderLabel = document.getElementById('selected-provider-label');
const toggleTemplatesBtn = document.getElementById('toggle-templates-btn');
const providerGrid = document.getElementById('provider-grid');

// State
let isAgentMode = false;
let isProcessing = false;
let stopRequested = false;
let apiKey = '';
let model = '';
let provider = 'gemini';
let baseUrl = '';
let currentAbortController = null;
let currentRunId = null;
let activePlaceholderMsg = null;
let pendingApprovalResolver = null;
const BRAND_IDENTITY_RESPONSE = "I'm rithcon Browser AI Agent extension. I help users operate, analyze, and automate websites in chat and agent mode. Made by awmrit.com.";
const chatHistory = [];
const MAX_CHAT_HISTORY_MESSAGES = 18;

const providerNames = {
    openai: 'OpenAI',
    'openai-compatible': 'OpenAI Compatible',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    ollama: 'Ollama',
    openrouter: 'OpenRouter',
    'lm-studio': 'LM Studio',
    azure: 'Azure',
    'aws-bedrock': 'AWS Bedrock',
    custom: 'Custom Provider'
};

const defaultModels = {
    openai: 'gpt-4o-mini',
    'openai-compatible': '',
    anthropic: 'claude-3-haiku-20240307',
    gemini: 'gemini-1.5-flash',
    ollama: 'llama3',
    openrouter: '',
    'lm-studio': '',
    azure: '',
    'aws-bedrock': '',
    custom: ''
};

const requiresBaseUrl = ['openai-compatible', 'ollama', 'lm-studio', 'custom'];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    updateModeUI();
    updateProcessingUI(false);

    userInput.addEventListener('input', resizeInputBox);
    userInput.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            await handleSendButtonClick();
        }
    });

    sendBtn.addEventListener('click', handleSendButtonClick);

    agentModeToggle.addEventListener('change', (event) => {
        isAgentMode = event.target.checked;
        updateModeUI();
    });

    settingsBtn.addEventListener('click', () => settingsOverlay.classList.remove('hidden'));
    closeSettingsBtn.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
    saveSettingsBtn.addEventListener('click', saveSettings);

    providerCards.forEach(card => {
        card.addEventListener('click', () => selectProvider(card.dataset.provider));
    });
    customProviderBtn.addEventListener('click', () => selectProvider('custom'));

    toggleTemplatesBtn.addEventListener('click', () => {
        providerGrid.classList.toggle('hidden');
        toggleTemplatesBtn.classList.toggle('collapsed');
    });

    modelInput.addEventListener('input', () => {
        modelInput.dataset.isDefault = 'false';
    });
});

async function handleSendButtonClick() {
    if (isProcessing) {
        stopCurrentProcess();
        return;
    }
    await handleSendMessage();
}

function selectProvider(selectedProvider) {
    provider = selectedProvider;

    providerCards.forEach(card => {
        const useBtn = card.querySelector('.use-btn');
        if (card.dataset.provider === selectedProvider) {
            card.classList.add('selected');
            if (useBtn) useBtn.textContent = 'SELECTED';
        } else {
            card.classList.remove('selected');
            if (useBtn) useBtn.textContent = 'USE';
        }
    });

    if (selectedProvider === 'custom') {
        customProviderBtn.classList.add('selected');
        customProviderBtn.textContent = 'SELECTED - Custom Provider';
    } else {
        customProviderBtn.classList.remove('selected');
        customProviderBtn.textContent = 'USE Custom Provider';
    }

    selectedProviderLabel.textContent = `Configuration (${providerNames[selectedProvider] || selectedProvider})`;

    if (!modelInput.value || modelInput.dataset.isDefault === 'true') {
        modelInput.value = defaultModels[selectedProvider] || '';
        modelInput.dataset.isDefault = 'true';
    }

    if (requiresBaseUrl.includes(selectedProvider)) {
        baseUrlGroup.style.display = 'block';
    } else {
        baseUrlGroup.style.display = 'none';
        baseUrlInput.value = '';
    }
}

function loadSettings() {
    chrome.storage.local.get(['apiKey', 'model', 'provider', 'baseUrl', 'agentModeEnabled', 'services'], (result) => {
        if (typeof result.apiKey === 'string') {
            apiKey = result.apiKey;
            apiKeyInput.value = result.apiKey;
        }

        if (typeof result.model === 'string' && result.model) {
            model = result.model;
            modelInput.value = result.model;
            modelInput.dataset.isDefault = 'false';
        }

        if (typeof result.baseUrl === 'string') {
            baseUrl = result.baseUrl;
            baseUrlInput.value = result.baseUrl;
        }

        selectProvider(result.provider || 'gemini');

        if (result.agentModeEnabled !== undefined) {
            isAgentMode = Boolean(result.agentModeEnabled);
            agentModeToggle.checked = isAgentMode;
        }

        if (result.services) {
            serviceYoutube.checked = Boolean(result.services.youtube);
            serviceGoogle.checked = Boolean(result.services.google);
        }

        updateModeUI();
    });
}

function saveSettings() {
    const newApiKey = apiKeyInput.value.trim();
    const newModel = modelInput.value.trim();
    const newBaseUrl = baseUrlInput.value.trim();

    chrome.storage.local.set({
        apiKey: newApiKey,
        model: newModel,
        provider,
        baseUrl: newBaseUrl,
        agentModeEnabled: isAgentMode,
        services: {
            youtube: serviceYoutube.checked,
            google: serviceGoogle.checked
        }
    }, () => {
        apiKey = newApiKey;
        model = newModel;
        baseUrl = newBaseUrl;

        saveStatus.classList.remove('hidden');
        setTimeout(() => saveStatus.classList.add('hidden'), 2500);
    });
}

function updateModeUI() {
    const [chatLabel, agentLabel] = modeLabels;
    if (isAgentMode) {
        chatLabel.classList.remove('active');
        agentLabel.classList.add('active');
        document.body.classList.add('agent-mode-active');
        document.body.classList.remove('chat-mode-active');
    } else {
        chatLabel.classList.add('active');
        agentLabel.classList.remove('active');
        document.body.classList.remove('agent-mode-active');
        document.body.classList.add('chat-mode-active');
        agentStatusBar.classList.add('hidden');
    }
}

function updateProcessingUI(processing) {
    isProcessing = processing;
    sendBtn.classList.toggle('is-stop', processing);
    sendBtn.title = processing ? 'Stop current process' : 'Send';

    settingsBtn.disabled = processing;
    agentModeToggle.disabled = processing;

    if (!processing) {
        activePlaceholderMsg = null;
        currentAbortController = null;
        currentRunId = null;
        stopRequested = false;
        pendingApprovalResolver = null;
    }
}

function stopCurrentProcess() {
    if (!isProcessing) {
        return;
    }

    stopRequested = true;
    window.appendActionLog('Stop requested by user');

    if (pendingApprovalResolver) {
        pendingApprovalResolver({ approved: false, reason: 'canceled' });
        pendingApprovalResolver = null;
    }

    if (currentAbortController) {
        currentAbortController.abort();
    }

    if (currentRunId) {
        chrome.runtime.sendMessage({ type: 'CANCEL_AGENT_RUN', runId: currentRunId }, () => {
            // Ignore cancellation callback errors when service worker restarts.
        });
    }

    if (activePlaceholderMsg) {
        activePlaceholderMsg.querySelector('.msg-content').textContent = 'Process stopped.';
    }
}

async function handleSendMessage() {
    const text = userInput.value.trim();
    if (!text) {
        return;
    }

    const localChatResponse = !isAgentMode
        ? await getBrandedIdentityResponse(text)
        : '';

    if (!localChatResponse && requiresApiKey(provider) && !apiKey) {
        appendMessage('Please configure your API key in settings first.', 'system-msg');
        return;
    }

    appendMessage(text, 'user-msg');
    if (!isAgentMode) {
        pushChatMessage('user', text);
    }
    userInput.value = '';
    resizeInputBox();

    if (localChatResponse) {
        appendMessage(localChatResponse, 'bot-msg');
        pushChatMessage('assistant', localChatResponse);
        return;
    }

    currentAbortController = new AbortController();
    currentRunId = isAgentMode ? `run-${Date.now()}` : null;
    stopRequested = false;
    updateProcessingUI(true);

    try {
        if (isAgentMode) {
            agentStatusBar.classList.remove('hidden');
            agentStatusText.textContent = 'Thinking through the best action plan...';

            if (typeof window.processAgentCommand !== 'function') {
                throw new Error('Agent logic is not loaded.');
            }

            await window.processAgentCommand(text, apiKey, provider, model, baseUrl, {
                runId: currentRunId,
                signal: currentAbortController.signal,
                shouldStop: () => stopRequested || currentAbortController.signal.aborted
            });
        } else {
            if (typeof window.generateChatResponse !== 'function') {
                throw new Error('API logic is not loaded.');
            }

            activePlaceholderMsg = appendMessage('...', 'bot-msg');
            const responseText = await window.generateChatResponse(
                buildChatHistoryForModel(),
                apiKey,
                provider,
                model,
                baseUrl,
                { signal: currentAbortController.signal }
            );
            activePlaceholderMsg.querySelector('.msg-content').textContent = responseText;
            pushChatMessage('assistant', responseText);
        }
    } catch (error) {
        const aborted = isAbortError(error) || stopRequested;
        if (aborted) {
            if (isAgentMode) {
                appendMessage('Process stopped.', 'system-msg');
                agentStatusBar.classList.add('hidden');
            } else if (activePlaceholderMsg) {
                activePlaceholderMsg.querySelector('.msg-content').textContent = 'Process stopped.';
            }
        } else if (isAgentMode) {
            window.appendActionLog(`Error: ${error.message}`);
            appendMessage(`Error: ${error.message}`, 'system-msg');
            agentStatusBar.classList.add('hidden');
        } else if (activePlaceholderMsg) {
            activePlaceholderMsg.querySelector('.msg-content').textContent = `Error: ${error.message}`;
        }
    } finally {
        updateProcessingUI(false);
    }
}

function requiresApiKey(selectedProvider) {
    return ['openai', 'anthropic', 'gemini', 'openrouter', 'azure', 'aws-bedrock'].includes(selectedProvider);
}

function pushChatMessage(role, content) {
    const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
    const normalizedContent = String(content || '').trim();
    if (!normalizedContent) {
        return;
    }

    chatHistory.push({ role: normalizedRole, content: normalizedContent });
    if (chatHistory.length > MAX_CHAT_HISTORY_MESSAGES) {
        chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY_MESSAGES);
    }
}

function buildChatHistoryForModel() {
    return chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES);
}

async function getBrandedIdentityResponse(text) {
    const local = getLocalChatModeResponse(text);
    if (local) {
        return local;
    }

    if (!apiKey || typeof window.generateChatResponse !== 'function') {
        return '';
    }

    const normalized = normalizeIntentText(text);
    if (!looksPotentiallyIdentityRelated(normalized)) {
        return '';
    }

    try {
        const classifierPrompt = [
            'Classify the user message.',
            'Return ONLY JSON like {"related": true} or {"related": false}.',
            'Set related=true only if the user is asking about assistant identity, name, creator, model, purpose, capabilities, or if they are asking "how are you".',
            `User message: ${text}`
        ].join('\n');

        const raw = await window.generateChatResponse(
            classifierPrompt,
            apiKey,
            provider,
            model,
            baseUrl
        );

        if (isRelatedByClassifier(raw)) {
            return BRAND_IDENTITY_RESPONSE;
        }
    } catch (_error) {
        // If classifier fails, fall through to normal chat.
    }

    return '';
}

function getLocalChatModeResponse(text) {
    const raw = String(text || '').toLowerCase().trim();
    if (!raw) {
        return '';
    }

    const normalized = normalizeIntentText(raw);

    const isIdentityQuery = /\b(who are you|what are you|your name|about you|are you ai|which ai|introduce yourself|what can you do|what do you do)\b/i.test(normalized)
        || (/\bwho\b/.test(normalized) && /\byou\b/.test(normalized))
        || /\b(are you|are u)\b/i.test(normalized)
        || /\b(what)\b.*\b(you|yourself|rithcon)\b/i.test(normalized);

    const isWellbeingQuery = /\b(how are you|how are u|hows it going|how do you do)\b/i.test(normalized);

    if (isIdentityQuery || isWellbeingQuery) {
        return BRAND_IDENTITY_RESPONSE;
    }

    return '';
}

function normalizeIntentText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/([a-z])\1{2,}/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function looksPotentiallyIdentityRelated(normalizedText) {
    if (!normalizedText) {
        return false;
    }

    const tokenCount = normalizedText.split(' ').filter(Boolean).length;
    if (tokenCount > 12) {
        return false;
    }

    return /\b(who|what|how|are you|name|creator|made|built|model|agent|bot|about you|yourself|capabilities|do you do)\b/i.test(normalizedText);
}

function isRelatedByClassifier(raw) {
    if (typeof raw !== 'string') {
        return false;
    }

    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

    try {
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed.related === 'boolean') {
            return parsed.related;
        }
        if (parsed && typeof parsed.related === 'string') {
            return parsed.related.toLowerCase() === 'true';
        }
    } catch (_error) {
        // Fallback below.
    }

    return /\btrue\b/i.test(cleaned) && !/\bfalse\b/i.test(cleaned);
}

function resizeInputBox() {
    userInput.style.height = 'auto';
    userInput.style.height = `${userInput.scrollHeight}px`;
}

function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || /abort|canceled|cancelled/i.test(error.message)));
}

// Utility to append messages to chat
function appendMessage(text, className) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${className}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.textContent = text;

    msgDiv.appendChild(contentDiv);
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return msgDiv;
}

function appendApprovalCard(stepSummary, riskInfo) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message approval-msg';

    const header = document.createElement('div');
    header.className = 'approval-title';
    header.textContent = `Confirmation required (${riskInfo.level.toUpperCase()} risk)`;

    const details = document.createElement('div');
    details.className = 'approval-details';
    details.textContent = stepSummary;

    const reasons = document.createElement('div');
    reasons.className = 'approval-reasons';
    reasons.textContent = `Reason: ${(riskInfo.reasons || []).join('; ') || 'Sensitive action detected.'}`;

    const actions = document.createElement('div');
    actions.className = 'approval-actions';

    const denyBtn = document.createElement('button');
    denyBtn.className = 'approval-btn deny';
    denyBtn.textContent = 'Deny';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'approval-btn approve';
    approveBtn.textContent = 'Approve';

    actions.appendChild(denyBtn);
    actions.appendChild(approveBtn);

    wrapper.appendChild(header);
    wrapper.appendChild(details);
    wrapper.appendChild(reasons);
    wrapper.appendChild(actions);

    chatContainer.appendChild(wrapper);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    return { wrapper, approveBtn, denyBtn };
}

// Global utility for agent.js to request sensitive-action approval
window.requestActionApproval = function (step, riskInfo = {}) {
    if (!isProcessing || stopRequested) {
        return Promise.resolve({ approved: false, reason: 'not-running' });
    }

    const stepSummary = typeof window.formatAgentStepSummary === 'function'
        ? window.formatAgentStepSummary(step)
        : `${step.action || 'ACTION'} pending approval`;

    return new Promise((resolve) => {
        const { wrapper, approveBtn, denyBtn } = appendApprovalCard(stepSummary, riskInfo);
        const timeoutMs = Number(riskInfo.timeoutMs) > 0 ? Number(riskInfo.timeoutMs) : 20000;
        let settled = false;

        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            approveBtn.disabled = true;
            denyBtn.disabled = true;
            pendingApprovalResolver = null;

            const resultText = result.approved ? 'approved' : `denied (${result.reason || 'manual'})`;
            window.appendActionLog(`Approval ${resultText}: ${stepSummary}`);
            resolve(result);
        };

        pendingApprovalResolver = finish;

        approveBtn.addEventListener('click', () => finish({ approved: true, reason: 'approved' }));
        denyBtn.addEventListener('click', () => finish({ approved: false, reason: 'denied' }));

        const timeout = setTimeout(() => {
            finish({ approved: false, reason: 'timeout' });
        }, timeoutMs);
    });
};

// Global utility for agent.js to post action logs
window.appendActionLog = function (text) {
    const timestamp = new Date().toLocaleTimeString([], { hour12: false });
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message action-log-msg';
    msgDiv.textContent = `[${timestamp}] ${text}`;
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
};

// Global utility for agent.js to update status bar
window.updateAgentStatus = function (text, isDone = false) {
    if (isDone) {
        agentStatusBar.classList.add('hidden');
        return;
    }
    agentStatusBar.classList.remove('hidden');
    agentStatusText.textContent = text;
};

window.appendMessage = appendMessage;
