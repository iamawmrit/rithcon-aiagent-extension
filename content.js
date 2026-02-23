(function initializeRithconContent() {
    if (window.__rithconContentListenerInstalled) {
        return;
    }

    window.__rithconContentListenerInstalled = true;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type !== 'RUN_ACTION') {
            return false;
        }

        handleAction(message.plan)
            .then((result) => sendResponse({ status: 'success', detail: result.detail, data: result.data }))
            .catch((error) => sendResponse({ status: 'error', error: error.message }));

        return true;
    });
})();

async function handleAction(planStep) {
    if (!planStep || typeof planStep !== 'object') {
        throw new Error('Invalid action payload.');
    }

    const action = String(planStep.action || '').toUpperCase();

    switch (action) {
        case 'PLAY_MEDIA':
            return await playMedia();
        case 'CLICK':
            return clickElement(planStep);
        case 'TYPE':
            return typeIntoField(planStep);
        case 'FILL_FORM':
            return fillForm(planStep);
        case 'ANALYZE_PAGE':
            return analyzePage(planStep);
        case 'SCRAPE_PAGE':
            return scrapePage(planStep);
        case 'VISUALIZE_PAGE':
            return visualizePage();
        default:
            throw new Error(`Unsupported content action: ${action}`);
    }
}

async function playMedia() {
    if (window.location.href.includes('youtube.com/results')) {
        const firstResult = document.querySelector('ytd-video-renderer a#video-title, a#video-title');
        if (!firstResult) {
            throw new Error('Could not find a video result to play.');
        }
        triggerClick(firstResult);
        return { detail: 'Opened first YouTube result.' };
    }

    const video = document.querySelector('video');
    if (video) {
        if (video.paused) {
            await video.play();
            return { detail: 'Started video playback.' };
        }
        video.pause();
        return { detail: 'Paused video playback.' };
    }

    const playButton = document.querySelector(
        'button[aria-label*="Play"], button[aria-label*="Pause"], .ytp-play-button, [data-testid="play-button"]'
    );
    if (playButton) {
        triggerClick(playButton);
        return { detail: 'Clicked media play/pause control.' };
    }

    throw new Error('No playable media found on this page.');
}

function clickElement(step) {
    const selector = typeof step.selector === 'string' ? step.selector.trim() : '';
    const text = typeof step.text === 'string' ? step.text.trim() : '';

    let target = null;
    if (selector) {
        target = document.querySelector(selector);
    }
    if (!target && text) {
        target = findClickableByText(text);
    }

    if (!target) {
        throw new Error(`Could not find element to click (${selector || `text="${text}"`}).`);
    }

    triggerClick(target);
    return { detail: `Clicked ${selector || `text "${text}"`}.` };
}

function typeIntoField(step) {
    const descriptor = {
        selector: step.selector,
        name: step.name,
        label: step.label,
        placeholder: step.placeholder,
        type: step.type
    };

    const field = findFieldElement(descriptor);
    if (!field) {
        throw new Error(`Input not found for selector "${step.selector || ''}".`);
    }

    const result = setFieldValue(field, String(step.text || ''), step.clear !== false);
    if (!result.verified) {
        throw new Error(`Unable to verify typed value for ${getElementSelector(field)}.`);
    }

    return { detail: `Typed into ${getElementSelector(field)}.` };
}

function fillForm(step) {
    if (!Array.isArray(step.fields) || !step.fields.length) {
        throw new Error('FILL_FORM requires at least one field.');
    }

    const filled = [];
    const missing = [];
    const verificationFailed = [];

    for (const fieldSpec of step.fields) {
        const element = findFieldElement(fieldSpec);
        if (!element) {
            missing.push(describeFieldSpec(fieldSpec));
            continue;
        }

        const value = String(fieldSpec.value ?? '');
        const result = setFieldValue(element, value, true);

        const label = fieldSpec.label
            || fieldSpec.name
            || fieldSpec.placeholder
            || element.name
            || element.id
            || element.tagName.toLowerCase();

        if (!result.verified) {
            verificationFailed.push(label);
            continue;
        }

        filled.push({ element, label });
    }

    if (!filled.length) {
        throw new Error(`No form fields matched or verified. Missing: ${missing.join(', ')}`);
    }

    let submitMethod = 'none';
    if (step.submit) {
        submitMethod = submitFilledForm(filled.map(item => item.element), step.submitSelector);
    }

    const detailParts = [`Filled ${filled.length} field(s)`];
    if (missing.length) {
        detailParts.push(`Missing ${missing.length} field(s): ${missing.slice(0, 3).join(', ')}`);
    }
    if (verificationFailed.length) {
        detailParts.push(`Verification failed for ${verificationFailed.length} field(s): ${verificationFailed.slice(0, 3).join(', ')}`);
    }
    if (step.submit) {
        detailParts.push(`Submitted form via ${submitMethod}`);
    }

    return {
        detail: `${detailParts.join('. ')}.`,
        data: {
            filledFields: filled.map(item => item.label),
            missingFields: missing,
            verificationFailed,
            submitMethod
        }
    };
}

function analyzePage(step) {
    const includeText = step.includeText !== false;
    const maxTextChars = clamp(Number(step.maxTextChars) || 3000, 500, 9000);

    const forms = Array.from(document.forms).slice(0, 8).map(form => {
        const fields = Array.from(form.querySelectorAll('input, textarea, select')).slice(0, 12).map(input => ({
            name: input.name || '',
            id: input.id || '',
            type: (input.type || input.tagName || '').toLowerCase(),
            placeholder: input.getAttribute('placeholder') || '',
            label: getElementLabelText(input)
        }));
        return {
            action: form.getAttribute('action') || '',
            method: (form.getAttribute('method') || 'get').toUpperCase(),
            selector: getElementSelector(form),
            fields
        };
    });

    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
        .slice(0, 16)
        .map(el => ({
            text: getElementDisplayText(el).slice(0, 90),
            selector: getElementSelector(el),
            type: (el.getAttribute('type') || '').toLowerCase()
        }))
        .filter(button => button.text || button.selector);

    const links = Array.from(document.querySelectorAll('a[href]'))
        .slice(0, 20)
        .map(link => ({
            text: getElementDisplayText(link).slice(0, 90),
            href: (link.href || '').slice(0, 240)
        }))
        .filter(link => link.href);

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .slice(0, 10)
        .map(node => cleanWhitespace(node.textContent || ''))
        .filter(Boolean);

    const loginHints = collectLoginHints(forms, buttons);
    const data = {
        url: window.location.href,
        title: document.title || '',
        headings,
        forms,
        buttons,
        links,
        loginHints
    };

    if (includeText) {
        data.textSample = extractVisibleText(maxTextChars);
    }

    return {
        detail: `Analyzed page: ${document.title || window.location.href}`,
        data
    };
}

function scrapePage(step) {
    const maxChars = clamp(Number(step.maxChars) || 5000, 800, 15000);
    const text = extractVisibleText(maxChars);
    return {
        detail: `Scraped ${text.length} characters from current page.`,
        data: {
            url: window.location.href,
            title: document.title || '',
            text,
            wordCount: text ? text.split(/\s+/).length : 0
        }
    };
}

function visualizePage() {
    const candidates = Array.from(document.querySelectorAll('form, input, textarea, select, button, a[href], [role="button"]'))
        .filter(isElementVisible)
        .slice(0, 80);

    if (!candidates.length) {
        return { detail: 'No interactive elements found to highlight.' };
    }

    candidates.forEach((element) => {
        element.dataset.rithconPrevOutline = element.style.outline || '';
        element.dataset.rithconPrevOffset = element.style.outlineOffset || '';
        element.style.outline = '2px solid #00c6ff';
        element.style.outlineOffset = '2px';
    });

    setTimeout(() => {
        candidates.forEach((element) => {
            element.style.outline = element.dataset.rithconPrevOutline || '';
            element.style.outlineOffset = element.dataset.rithconPrevOffset || '';
            delete element.dataset.rithconPrevOutline;
            delete element.dataset.rithconPrevOffset;
        });
    }, 2200);

    return { detail: `Highlighted ${candidates.length} interactive element(s).` };
}

function findFieldElement(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
        return null;
    }

    if (typeof descriptor.selector === 'string' && descriptor.selector.trim()) {
        const selected = document.querySelector(descriptor.selector.trim());
        if (isFillableField(selected)) {
            return selected;
        }
    }

    const candidates = Array.from(document.querySelectorAll('input, textarea, select')).filter(isFillableField);
    if (!candidates.length) {
        return null;
    }

    const query = {
        name: normalizeText(descriptor.name),
        label: normalizeText(descriptor.label),
        placeholder: normalizeText(descriptor.placeholder),
        type: normalizeText(descriptor.type)
    };

    let bestElement = null;
    let bestScore = -1;

    for (const element of candidates) {
        const score = scoreFieldCandidate(element, query);
        if (score > bestScore) {
            bestScore = score;
            bestElement = element;
        }
    }

    if (bestScore <= 0) {
        return null;
    }

    return bestElement;
}

function scoreFieldCandidate(element, query) {
    const name = normalizeText(element.name);
    const id = normalizeText(element.id);
    const placeholder = normalizeText(element.getAttribute('placeholder') || '');
    const aria = normalizeText(element.getAttribute('aria-label') || '');
    const label = normalizeText(getElementLabelText(element));
    const autocomplete = normalizeText(element.getAttribute('autocomplete') || '');
    const actualType = normalizeText(element.type || element.tagName || '');

    let score = 0;

    score += exactOrContainsScore(name, query.name, 30, 10);
    score += exactOrContainsScore(id, query.name, 26, 8);
    score += exactOrContainsScore(label, query.label || query.name, 28, 10);
    score += exactOrContainsScore(placeholder, query.placeholder || query.label || query.name, 18, 7);
    score += exactOrContainsScore(aria, query.label || query.name, 18, 6);
    score += exactOrContainsScore(autocomplete, query.name || query.label, 16, 5);

    if (query.type) {
        if (actualType === query.type) {
            score += 10;
        } else if (query.type === 'text' && ['search', 'email', 'url'].includes(actualType)) {
            score += 4;
        }
    }

    return score;
}

function exactOrContainsScore(haystack, needle, exactScore, containsScore) {
    if (!needle) {
        return 0;
    }
    if (haystack === needle) {
        return exactScore;
    }
    if (haystack.includes(needle)) {
        return containsScore;
    }
    return 0;
}

function isFillableField(element) {
    if (!element) return false;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
        return false;
    }
    if (element.disabled || element.readOnly) {
        return false;
    }
    if (element instanceof HTMLInputElement) {
        const type = (element.type || '').toLowerCase();
        if (['hidden', 'button', 'submit', 'reset', 'image', 'file'].includes(type)) {
            return false;
        }
    }
    return isElementVisible(element);
}

function submitFilledForm(filledElements, submitSelector) {
    if (typeof submitSelector === 'string' && submitSelector.trim()) {
        const submitElement = document.querySelector(submitSelector.trim());
        if (submitElement && isElementVisible(submitElement)) {
            triggerClick(submitElement);
            return 'submitSelector';
        }
    }

    const form = filledElements.find(element => element.form)?.form || null;
    if (form) {
        const submitButton = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        if (submitButton && isElementVisible(submitButton)) {
            triggerClick(submitButton);
            return 'formSubmitButton';
        }

        if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return 'requestSubmit';
        }

        const semanticButton = findSemanticSubmitButton(form);
        if (semanticButton) {
            triggerClick(semanticButton);
            return 'semanticButtonInForm';
        }
    }

    const globalSemanticButton = findSemanticSubmitButton(document);
    if (globalSemanticButton) {
        triggerClick(globalSemanticButton);
        return 'semanticButtonGlobal';
    }

    return 'none';
}

function findSemanticSubmitButton(root) {
    const candidates = Array.from(root.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'));
    return candidates.find(button => {
        if (!isElementVisible(button)) {
            return false;
        }
        const text = getElementDisplayText(button).toLowerCase();
        return /submit|sign\s?in|login|register|sign\s?up|continue|next/.test(text);
    }) || null;
}

function setFieldValue(element, value, clearExisting) {
    element.focus();

    if (element instanceof HTMLSelectElement) {
        const target = value.toLowerCase();
        const option = Array.from(element.options).find(opt => {
            const optionValue = String(opt.value || '').toLowerCase();
            const optionText = String(opt.textContent || '').toLowerCase();
            return optionValue === target || optionText.includes(target);
        });

        if (option) {
            element.value = option.value;
        }

        element.dispatchEvent(new Event('change', { bubbles: true }));
        const verified = option ? element.value === option.value : false;
        element.blur();
        return { applied: Boolean(option), verified, currentValue: element.value || '' };
    }

    const previousValue = clearExisting ? '' : (element.value || '');
    const nextValue = `${previousValue}${value}`;

    const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (valueSetter) {
        valueSetter.call(element, nextValue);
    } else {
        element.value = nextValue;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    const normalizedCurrent = normalizeText(String(element.value || ''));
    const normalizedExpected = normalizeText(nextValue);
    const verified = normalizedCurrent === normalizedExpected;

    element.blur();
    return { applied: true, verified, currentValue: element.value || '' };
}

function findClickableByText(text) {
    const normalizedTarget = normalizeText(text);
    if (!normalizedTarget) {
        return null;
    }

    const clickableElements = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'));
    return clickableElements.find(element => {
        if (!isElementVisible(element)) return false;
        const elementText = normalizeText(getElementDisplayText(element));
        return elementText === normalizedTarget || elementText.includes(normalizedTarget);
    }) || null;
}

function getElementLabelText(element) {
    if (!element) return '';

    if (element.labels && element.labels.length) {
        return Array.from(element.labels).map(label => cleanWhitespace(label.textContent || '')).join(' ').trim();
    }

    const closestLabel = element.closest('label');
    if (closestLabel) {
        return cleanWhitespace(closestLabel.textContent || '');
    }

    const ariaLabelledBy = element.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
        const labelText = ariaLabelledBy
            .split(/\s+/)
            .map(id => document.getElementById(id))
            .filter(Boolean)
            .map(label => cleanWhitespace(label.textContent || ''))
            .join(' ');
        if (labelText) return labelText;
    }

    return '';
}

function getElementSelector(element) {
    if (!element) return '';
    if (element.id) {
        return `#${escapeCssIdentifier(element.id)}`;
    }

    const name = element.getAttribute('name');
    if (name) {
        return `${element.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
    }

    const className = (element.className || '').split(/\s+/).find(Boolean);
    if (className) {
        return `${element.tagName.toLowerCase()}.${escapeCssIdentifier(className)}`;
    }

    return element.tagName.toLowerCase();
}

function triggerClick(element) {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    element.click();
}

function getElementDisplayText(element) {
    if (!element) return '';
    if (element instanceof HTMLInputElement && (element.type === 'submit' || element.type === 'button')) {
        return element.value || '';
    }
    return cleanWhitespace(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
}

function collectLoginHints(forms, buttons) {
    const keywords = /(login|log in|sign in|register|sign up|password|email|username)/i;
    const hints = [];

    forms.forEach(form => {
        const fieldText = form.fields.map(field => `${field.name} ${field.placeholder} ${field.label} ${field.type}`).join(' ');
        if (keywords.test(fieldText)) {
            hints.push(`Form likely auth (${form.fields.length} field${form.fields.length === 1 ? '' : 's'})`);
        }
    });

    buttons.forEach(button => {
        if (keywords.test(button.text)) {
            hints.push(`Button: ${button.text}`);
        }
    });

    return Array.from(new Set(hints)).slice(0, 8);
}

function extractVisibleText(maxChars) {
    const bodyText = cleanWhitespace(document.body?.innerText || '');
    return bodyText.slice(0, maxChars);
}

function cleanWhitespace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(text) {
    return cleanWhitespace(text).toLowerCase();
}

function describeFieldSpec(fieldSpec) {
    return fieldSpec.label
        || fieldSpec.name
        || fieldSpec.placeholder
        || fieldSpec.selector
        || 'unknown field';
}

function isElementVisible(element) {
    if (!element || !element.ownerDocument || !element.ownerDocument.documentElement.contains(element)) {
        return false;
    }
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') {
        return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function escapeCssIdentifier(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9\-_]/g, '\\$&');
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
