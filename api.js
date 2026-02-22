// Global function to be called from sidepanel.js for Chat Mode
window.generateChatResponse = async function (messagesText, apiKey, provider, model, baseUrl) {
    if (provider === 'gemini') {
        return await fetchGemini(messagesText, apiKey, model);
    } else if (provider === 'anthropic') {
        return await fetchAnthropic(messagesText, apiKey, model);
    } else if (['openai', 'openai-compatible', 'lm-studio', 'openrouter', 'custom'].includes(provider)) {
        // Use OpenAI format for these
        let actualBaseUrl = 'https://api.openai.com/v1';
        if (provider === 'openrouter') actualBaseUrl = 'https://openrouter.ai/api/v1';
        if (provider === 'lm-studio') actualBaseUrl = 'http://localhost:1234/v1';
        if (provider === 'custom' || provider === 'openai-compatible') actualBaseUrl = baseUrl || actualBaseUrl;

        return await fetchOpenAI(messagesText, apiKey, model, actualBaseUrl);
    } else {
        throw new Error(`Provider ${provider} is not fully supported yet.`);
    }
};

async function fetchGemini(text, apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: text }] }]
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    if (data.candidates && data.candidates.length > 0) {
        return data.candidates[0].content.parts[0].text;
    }
    throw new Error("Invalid response format from Gemini");
}

async function fetchOpenAI(text, apiKey, model, baseUrl) {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) // make key optional for local
        },
        body: JSON.stringify({
            model: model || 'gpt-4o-mini',
            messages: [{ role: 'user', content: text }]
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function fetchAnthropic(text, apiKey, model) {
    const url = 'https://api.anthropic.com/v1/messages';
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerously-allow-custom-cors': 'true' // usually required if calling from extension, but extensions have host permissions anyway
        },
        body: JSON.stringify({
            model: model || 'claude-3-haiku-20240307',
            max_tokens: 1024,
            messages: [{ role: 'user', content: text }]
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    return data.content[0].text;
}
