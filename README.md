# 🌐 rithcon – Autonomous Browser AI Agent

[![GitHub Repository](https://img.shields.io/badge/GitHub-iamawmrit%2Frithcon--aiagent--extension-blue?logo=github)](https://github.com/iamawmrit/rithcon-aiagent-extension)

**rithcon** is an open-source Chrome Extension that acts as a browser-level AI agent. It is capable of both standard chat-based responses and autonomous browser control. It functions like a lightweight, autonomous BrowserOS AI living in a sleek, split-pane side panel with a stunning neon sky blue aesthetic.

## ✨ Features

- **Dual-Mode AI:**
  - 💬 **Chat Mode**: Standard conversational assistant. Pure reasoning, no browser actions.
  - 🤖 **Agent Mode**: Takes actions inside your browser (clicks, navigates, searches Google/YouTube, plays media, analyzes pages, fills forms) based on your intent.
- **Dynamic Configuration**: Connect your own API keys securely. Support for a wide range of providers including Google Gemini, OpenAI, Anthropic, Ollama, OpenRouter, and custom endpoints.
- **Security First**:
  - API keys are stored with the Chrome Storage API (`local` area).
  - Sensitive steps (for example form submit/auth-related actions) require explicit approval.
  - Credentials extracted from prompts are treated as ephemeral (in-memory only) and redacted from logs.
- **Human-like Agent Flow**: The agent shows a concise plan, executes step-by-step, asks for approval on high-risk actions, and reports a final run summary.
- **Prompt-based Multi-Tab Control**: No scope dropdown. Use prompt phrases such as `all tabs` or `on github.com tabs` to run in parallel where needed.
- **Split Interface UI**: Modern UI that opens in Chrome's side panel, allowing you to view and interact with web pages normally while commanding the agent. Complete with smooth animations and crisp SVG icons.
- **100% Free & Open Source**: Anyone can install, use, modify, and contribute to rithcon.

## 🚀 Installation (Unpacked Extension)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/iamawmrit/rithcon-aiagent-extension.git
   ```
2. Open Google Chrome (or any Chromium-based browser like Brave/Edge).
3. In the address bar, type `chrome://extensions/` and hit Enter.
4. Enable **Developer mode** using the toggle switch in the top right corner.
5. Click the **Load unpacked** button.
6. Select the `rithcon` directory (the folder containing `manifest.json`).

## 💡 How to Use

1. Click the **rithcon** extension icon in your Chrome toolbar. A side panel will open.
2. Click the **Settings icon** (gear) in the top right corner to open configuration.
3. Select your preferred AI Provider from the quick templates grid (e.g., Google Gemini, OpenAI, etc.).
4. Enter the matching API Key for that provider.
5. Click **Save Configurations** and close the settings panel.

### Chat Mode
- Just type your question in the input box and hit Enter. The AI will respond with text, answering questions or writing code for you.

### Agent Mode
- Toggle the switch from "Chat Mode" to "Agent Mode".
- Try typing commands like:
  - *"Search for funny cat videos on YouTube"*
  - *"Play some lo-fi music"*
  - *"Google the weather in Tokyo"*
  - *"Analyze this page and summarize it"*
  - *"Register on https://example.com with email random and password random"*
  - *"Analyze all tabs"*
  - *"Scrape on github.com tabs"*
- The AI analyzes intent, shows a concise step plan, executes actions, and logs status in real time.
- For high-risk actions (submit/auth/navigation risk), the panel asks for explicit confirmation.

## 🏗️ Architecture

- `manifest.json`: Configuration, using Manifest V3 limits and `sidePanel` API.
- `background.js`: Service worker handling state and orchestrating cross-script messaging.
- `sidepanel.*`: HTML, CSS (clean, neon/sky blue modern aesthetics), and JavaScript UI logic.
- `api.js`: Abstraction layer to seamlessly connect to different model APIs.
- `agent.js`: Core system prompt, action intent parsing, and execution lifecycle.
- `content.js`: DOM manipulator injected into tabs to click, navigate, and control media elements.

## 🤝 Contributing

Contributions are always welcome! Since **rithcon** is an open-source project, feel free to fork the repository and submit a Pull Request.

> Repository: [https://github.com/iamawmrit/rithcon-aiagent-extension](https://github.com/iamawmrit/rithcon-aiagent-extension)

1. Fork the Project on [GitHub](https://github.com/iamawmrit/rithcon-aiagent-extension/fork)
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request at [github.com/iamawmrit/rithcon-aiagent-extension/pulls](https://github.com/iamawmrit/rithcon-aiagent-extension/pulls)

## ⚠️ Disclaimer & Safety

- Granting an AI control over your browser active tab carries inherent risks. Avoid using Agent Mode on sensitive sites containing personal data or banking information until you fully understand how the agent chooses its actions.
- The agent runs entirely locally on your machine except for the standard remote LLM API calls it makes to your configured provider.
- The extension does not persist user login credentials from task prompts; they are used in-memory for the current run only.

## 📄 License
Distributed under the MIT License. See [LICENSE](https://github.com/iamawmrit/rithcon-aiagent-extension/blob/main/LICENSE) for more information.
