// The background service worker manages extension lifecycle and handles communication.

// Open the side panel when the extension icon is clicked
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

// Initialize default settings on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['apiKey', 'model', 'agentModeEnabled'], (result) => {
        if (Object.keys(result).length === 0) {
            chrome.storage.local.set({
                apiKey: '',
                model: 'gemini-1.5-flash',
                agentModeEnabled: false
            });
        }
    });
});

// Listener for messages from the Side Panel or Content Scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'EXECUTE_AGENT_PLAN') {
        // Expected structure: { type: 'EXECUTE_AGENT_PLAN', plan: { action: 'SEARCH', query: '...' } }
        executePlanInActiveTab(request.plan)
            .then((status) => sendResponse({ status: 'success', detail: status }))
            .catch((err) => sendResponse({ status: 'error', error: err.message }));

        return true; // Indicate that we will send a response asynchronously
    }
});

async function executePlanInActiveTab(plan) {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found");

    const { action, query, url } = plan;

    // Handle navigation actions directly in the background page to avoid injection issues on restricted URLs
    if (action === 'NAVIGATE') {
        await chrome.tabs.update(tab.id, { url: url });
        return `Navigating to ${url}`;
    } else if (action === 'SEARCH_YOUTUBE') {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        if (!tab.url || !tab.url.includes('youtube.com/results')) {
            await chrome.tabs.update(tab.id, { url: searchUrl });
            return `Navigating to YouTube search for: ${query}`;
        }
        return `Already on YouTube search`;
    } else if (action === 'GOOGLE_SEARCH') {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        if (!tab.url || !tab.url.includes('google.com/search')) {
            await chrome.tabs.update(tab.id, { url: searchUrl });
            return `Navigating to Google search for: ${query}`;
        }
        return `Already on Google search`;
    }

    // For other actions we must inject content.js, but check if we're on a restricted URL first
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('brave://') || tab.url.startsWith('about:'))) {
        throw new Error(`Cannot access a ${new URL(tab.url).protocol}// URL. Please navigate to a regular web page first.`);
    }

    // Inject content script if not already injected (Manifest V3 allows dynamic injection)
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
        });

        // Now send the message to the content script
        return new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tab.id, { type: 'RUN_ACTION', plan: plan }, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                resolve(response ? response.detail : 'Success');
            });
        });
    } catch (err) {
        throw new Error(`Failed to execute script: ${err.message}`);
    }
}
