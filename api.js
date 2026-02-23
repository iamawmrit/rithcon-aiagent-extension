// Global function called by sidepanel.js and agent.js.
window.generateChatResponse = async function (messagesText, apiKey, provider, model, baseUrl, options = {}) {
    const text = String(messagesText || '').trim();
    if (!text) {
        throw new Error('Prompt cannot be empty.');
    }

    const signal = options.signal;

    if (provider === 'gemini') {
        return await fetchGemini(text, apiKey, model, signal);
    }

    if (provider === 'anthropic') {
        return await fetchAnthropic(text, apiKey, model, signal);
    }

    if (['openai', 'openai-compatible', 'lm-studio', 'openrouter', 'custom'].includes(provider)) {
        let actualBaseUrl = 'https://api.openai.com/v1';
        if (provider === 'openrouter') actualBaseUrl = 'https://openrouter.ai/api/v1';
        if (provider === 'lm-studio') actualBaseUrl = 'http://localhost:1234/v1';
        if (provider === 'custom' || provider === 'openai-compatible') actualBaseUrl = baseUrl || actualBaseUrl;

        return await fetchOpenAI(text, apiKey, model, actualBaseUrl, signal);
    }

    throw new Error(`Provider ${provider} is not fully supported yet.`);
};

async function fetchGemini(text, apiKey, model, signal) {
    const resolvedModel = (model || 'gemini-1.5-flash').trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolvedModel)}:generateContent?key=${encodeURIComponent(apiKey || '')}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
            contents: [{ parts: [{ text }] }]
        })
    });

    if (!response.ok) {
        throw new Error(await readApiError(response));
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
        throw new Error('Invalid response format from Gemini.');
    }
    return content;
}

async function fetchOpenAI(text, apiKey, model, baseUrl, signal) {
    const url = `${String(baseUrl || '').replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        signal,
        body: JSON.stringify({
            model: model || 'gpt-4o-mini',
            messages: [{ role: 'user', content: text }]
        })
    });

    if (!response.ok) {
        throw new Error(await readApiError(response));
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('Invalid response format from OpenAI-compatible API.');
    }
    return content;
}

async function fetchAnthropic(text, apiKey, model, signal) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        signal,
        body: JSON.stringify({
            model: model || 'claude-3-haiku-20240307',
            max_tokens: 1024,
            messages: [{ role: 'user', content: text }]
        })
    });

    if (!response.ok) {
        throw new Error(await readApiError(response));
    }

    const data = await response.json();
    const content = data?.content?.[0]?.text;
    if (!content) {
        throw new Error('Invalid response format from Anthropic.');
    }
    return content;
}

async function readApiError(response) {
    if (response.status === 401) {
        return 'Authentication failed. Check API key.';
    }

    const fallback = `API error: ${response.status}`;
    try {
        const payload = await response.json();
        return payload?.error?.message || payload?.message || fallback;
    } catch (_error) {
        return fallback;
    }
}
