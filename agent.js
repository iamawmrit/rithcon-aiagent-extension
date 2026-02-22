// agent.js handles the decision rules and planning when the user is in Agent Mode

window.processAgentCommand = async function (prompt, apiKey, provider, model) {
    // 1. Analyze intent and generate an action plan
    window.updateAgentStatus("Analyzing user intent...");
    appendActionLog("Planning actions for: " + prompt);

    const systemPrompt = `You are rithcon, an autonomous browser AI agent. 
You must generate a step-by-step action plan to fulfill the user's request.
Available actions you can output as JSON array:
[
  { "action": "NAVIGATE", "url": "https://..." },
  { "action": "SEARCH_YOUTUBE", "query": "..." },
  { "action": "PLAY_MEDIA" },
  { "action": "CLICK", "selector": "..." },
  { "action": "GOOGLE_SEARCH", "query": "..." },
  { "action": "REPLY", "message": "..." }
]
Output ONLY the raw JSON array. Do not wrap in markdown \`\`\`json.`;

    const fullPrompt = `${systemPrompt}\n\nUser Request: ${prompt}\n\nIf the request is to play music on YouTube, output SEARCH_YOUTUBE followed by PLAY_MEDIA. If it's a google search, output GOOGLE_SEARCH. If it's a general question and doesn't explicitly mention taking a browser action, output a REPLY.`;

    let planJsonStr;
    try {
        // We re-use generateChatResponse from api.js but with the system prompt injected
        planJsonStr = await window.generateChatResponse(fullPrompt, apiKey, provider, model);
    } catch (err) {
        throw new Error(`Agent reasoning failed: ${err.message}`);
    }

    // Clean up markdown if the LLM still wrapped it
    planJsonStr = planJsonStr.replace(/```json/g, '').replace(/```/g, '').trim();

    let plan = [];
    try {
        plan = JSON.parse(planJsonStr);
    } catch (err) {
        // Fallback if parsing fails - just reply
        plan = [{ action: "REPLY", message: "I successfully analyzed your request but I couldn't format the browser actions properly. Here is what I wanted to do: " + planJsonStr }];
    }

    // 2. Execute the plan step by step
    for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        window.updateAgentStatus(`Executing step ${i + 1}/${plan.length}: ${step.action}`);

        if (step.action === 'REPLY') {
            window.appendMessage(step.message, 'bot-msg');
            continue;
        }

        window.appendActionLog(`Action: ${step.action} ${step.query || step.url || ''}`);

        try {
            // Send command to background service worker to execute in the active tab
            const status = await sendCommandToBackground(step);
            window.appendActionLog(`Status: ${status.detail || status.status}`);

            // Artificial delay between actions to make them observable
            if (i < plan.length - 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        } catch (err) {
            window.appendActionLog(`Action Failed: ${err.message}`);
            window.appendMessage(`I encountered an error trying to ${step.action}. ${err.message}`, 'system-msg');
            break; // Stop execution on failure
        }
    }

    window.updateAgentStatus("Agent ready", true);
    window.appendMessage("Finished executing actions.", 'system-msg');
};

function sendCommandToBackground(planStep) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'EXECUTE_AGENT_PLAN', plan: planStep }, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.status === 'error') {
                return reject(new Error(response.error));
            }
            resolve(response || { status: 'success' });
        });
    });
}
