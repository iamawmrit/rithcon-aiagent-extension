// Setup listener for commands from the background service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RUN_ACTION') {
        handleAction(message.plan)
            .then(result => sendResponse({ status: 'success', detail: result }))
            .catch(err => sendResponse({ status: 'error', error: err.message }));

        return true; // Keep the message channel open for asynchronous response
    }
});

async function handleAction(planStep) {
    const { action, query, url, selector, message } = planStep;

    if (action === 'NAVIGATE') {
        window.location.href = url;
        return `Navigating to ${url}`;
    }
    else if (action === 'SEARCH_YOUTUBE') {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        if (!window.location.href.includes('youtube.com/results')) {
            window.location.href = searchUrl;
            return `Navigating to YouTube search for: ${query}`;
        }
        return `Already on YouTube search`;
    }
    else if (action === 'GOOGLE_SEARCH') {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        if (!window.location.href.includes('google.com/search')) {
            window.location.href = searchUrl;
            return `Navigating to Google search for: ${query}`;
        }
        return `Already on Google search`;
    }
    else if (action === 'PLAY_MEDIA') {
        if (window.location.href.includes('youtube.com/results')) {
            // If we are on search results, click the first video reel/thumbnail
            const videoLink = document.querySelector('ytd-video-renderer a#video-title');
            if (videoLink) {
                videoLink.click();
                return `Clicked first video result`;
            } else {
                throw new Error("Could not find a video to play. Results might not have loaded yet.");
            }
        } else {
            // General play/pause toggle attempt
            const video = document.querySelector('video');
            if (video) {
                if (video.paused) {
                    video.play();
                    return `Played active video element`;
                } else {
                    video.pause();
                    return `Paused active video element`;
                }
            } else {
                // Try clicking a generic play button if video tag is not found
                const playBtn = document.querySelector('button[aria-label="Play"], button[aria-label="Pause"], .ytp-play-button');
                if (playBtn) {
                    playBtn.click();
                    return `Clicked play/pause button`;
                }
            }
            throw new Error("No media element found to play/pause.");
        }
    }
    else if (action === 'CLICK') {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Element not found for selector: ${selector}`);

        // Simulate a real click
        element.click();
        return `Clicked element: ${selector}`;
    }
    else {
        throw new Error(`Unknown action type: ${action}`);
    }
}
