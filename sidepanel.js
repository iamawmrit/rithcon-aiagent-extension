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
let apiKey = '';
let model = '';
let provider = 'gemini';
let baseUrl = '';

const providerNames = {
    'openai': 'OpenAI',
    'openai-compatible': 'OpenAI Compatible',
    'anthropic': 'Anthropic',
    'gemini': 'Gemini',
    'ollama': 'Ollama',
    'openrouter': 'OpenRouter',
    'lm-studio': 'LM Studio',
    'azure': 'Azure',
    'aws-bedrock': 'AWS Bedrock',
    'custom': 'Custom Provider'
};

const defaultModels = {
    'openai': 'gpt-4o-mini',
    'openai-compatible': '',
    'anthropic': 'claude-3-haiku-20240307',
    'gemini': 'gemini-1.5-flash',
    'ollama': 'llama3',
    'openrouter': '',
    'lm-studio': '',
    'azure': '',
    'aws-bedrock': '',
    'custom': ''
};

const requiresBaseUrl = ['openai-compatible', 'ollama', 'lm-studio', 'custom'];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();

    // Auto-resize textarea
    userInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    // Event Listeners
    sendBtn.addEventListener('click', handleSendMessage);
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });

    agentModeToggle.addEventListener('change', (e) => {
        isAgentMode = e.target.checked;
        updateModeUI();
    });

    settingsBtn.addEventListener('click', () => settingsOverlay.classList.remove('hidden'));
    closeSettingsBtn.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
    saveSettingsBtn.addEventListener('click', saveSettings);

    // Provider Grids
    providerCards.forEach(card => {
        card.addEventListener('click', () => selectProvider(card.dataset.provider));
    });
    customProviderBtn.addEventListener('click', () => selectProvider('custom'));

    toggleTemplatesBtn.addEventListener('click', () => {
        providerGrid.classList.toggle('hidden');
        toggleTemplatesBtn.classList.toggle('collapsed');
    });
});

function selectProvider(selectedProvider) {
    provider = selectedProvider;

    // Update UI
    providerCards.forEach(card => {
        if (card.dataset.provider === selectedProvider) {
            card.classList.add('selected');
            card.querySelector('.use-btn').textContent = 'SELECTED';
        } else {
            card.classList.remove('selected');
            card.querySelector('.use-btn').textContent = 'USE';
        }
    });

    if (selectedProvider === 'custom') {
        customProviderBtn.classList.add('selected');
        customProviderBtn.textContent = 'SELECTED - Custom Provider';
    } else {
        customProviderBtn.classList.remove('selected');
        customProviderBtn.textContent = 'USE Custom Provider';
    }

    selectedProviderLabel.textContent = `Configuration (${providerNames[selectedProvider]})`;

    // Set default model if empty and changing provider
    if (!modelInput.value || modelInput.dataset.isDefault === 'true') {
        modelInput.value = defaultModels[selectedProvider] || '';
        modelInput.dataset.isDefault = 'true';
    }

    // Toggle base URL
    if (requiresBaseUrl.includes(selectedProvider)) {
        baseUrlGroup.style.display = 'block';
    } else {
        baseUrlGroup.style.display = 'none';
        baseUrlInput.value = '';
    }
}

// Clear default flag if user types
modelInput.addEventListener('input', () => {
    modelInput.dataset.isDefault = 'false';
});

function loadSettings() {
    chrome.storage.local.get(['apiKey', 'model', 'provider', 'baseUrl', 'agentModeEnabled', 'services'], (result) => {
        if (result.apiKey) apiKeyInput.value = result.apiKey;
        if (result.model) {
            modelInput.value = result.model;
            modelInput.dataset.isDefault = 'false';
            model = result.model;
        }
        if (result.baseUrl) {
            baseUrlInput.value = result.baseUrl;
            baseUrl = result.baseUrl;
        }

        const savedProvider = result.provider || 'gemini';
        selectProvider(savedProvider);

        if (result.agentModeEnabled !== undefined) {
            agentModeToggle.checked = result.agentModeEnabled;
            isAgentMode = result.agentModeEnabled;
            updateModeUI();
        }

        if (result.services) {
            serviceYoutube.checked = result.services.youtube;
            serviceGoogle.checked = result.services.google;
        }
    });
}

function saveSettings() {
    const newApiKey = apiKeyInput.value;
    const newModel = modelInput.value;
    const newBaseUrl = baseUrlInput.value;

    chrome.storage.local.set({
        apiKey: newApiKey,
        model: newModel,
        provider: provider,
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
        setTimeout(() => saveStatus.classList.add('hidden'), 3000);
    });
}

function updateModeUI() {
    const [chatLabel, agentLabel] = modeLabels;
    if (isAgentMode) {
        chatLabel.classList.remove('active');
        agentLabel.classList.add('active');
        document.body.classList.add('agent-mode-active');
    } else {
        chatLabel.classList.add('active');
        agentLabel.classList.remove('active');
        document.body.classList.remove('agent-mode-active');
        agentStatusBar.classList.add('hidden');
    }
}

async function handleSendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    appendMessage(text, 'user-msg');
    userInput.value = '';
    userInput.style.height = 'auto';

    if (!apiKey) {
        appendMessage("Please configure your API key in settings first.", 'system-msg');
        return;
    }

    if (isAgentMode) {
        agentStatusBar.classList.remove('hidden');
        agentStatusText.textContent = "Analyzing intent...";

        try {
            // Delegate to agent.js to handle logic
            if (typeof window.processAgentCommand === 'function') {
                await window.processAgentCommand(text, apiKey, provider, model, baseUrl);
            } else {
                appendMessage("Agent logic not loaded.", 'system-msg');
            }
        } catch (error) {
            appendActionLog(`Error: ${error.message}`);
            agentStatusBar.classList.add('hidden');
        }

    } else {
        // Chat Mode
        const placeholderMsg = appendMessage("...", 'bot-msg');
        try {
            // Delegate to api.js to handle chat completion
            if (typeof window.generateChatResponse === 'function') {
                const responseText = await window.generateChatResponse(text, apiKey, provider, model, baseUrl);
                placeholderMsg.querySelector('.msg-content').textContent = responseText;
            } else {
                placeholderMsg.querySelector('.msg-content').textContent = "API logic not loaded.";
            }
        } catch (error) {
            placeholderMsg.querySelector('.msg-content').textContent = `Error: ${error.message}`;
        }
    }
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

// Global utility for agent.js to post action logs
window.appendActionLog = function (text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message action-log-msg`;
    msgDiv.textContent = `> ${text}`;
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
};

// Global utility for agent.js to update status bar
window.updateAgentStatus = function (text, isDone = false) {
    if (isDone) {
        agentStatusBar.classList.add('hidden');
    } else {
        agentStatusBar.classList.remove('hidden');
        agentStatusText.textContent = text;
    }
};
