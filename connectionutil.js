/**
 * Summaryception Connection Utility
 *
 * Routes summarization requests through one of four backends:
 *   - default:  SillyTavern's generateRaw() (active connection)
 *   - profile:  ST Connection Profile via ConnectionManagerRequestService
 *   - ollama:   Ollama instance (via ST CORS proxy to avoid browser CORS issues)
 *   - openai:   OpenAI-compatible endpoint (via ST CORS proxy)
 *
 * CORS Note: Ollama and OpenAI modes route through ST's /cors/ proxy endpoint
 * to avoid browser CORS restrictions. Requires enableCorsProxy: true in config.yaml
 * OR the target server must have permissive CORS headers.
 *
 * AGPL-3.0
 */

const MODULE_NAME = '[Summaryception][Connection]';

// ─── CORS Proxy Helper ───────────────────────────────────────────────

/**
 * Wrap a URL through SillyTavern's CORS proxy if needed.
 * Falls back to direct URL if CORS proxy is unavailable.
 * @param {string} url - The target URL
 * @param {boolean} useProxy - Whether to attempt proxying
 * @returns {string} - The (possibly proxied) URL
 */
function proxiedUrl(url, useProxy = true) {
    if (!useProxy) return url;
    // ST's CORS proxy endpoint: /cors/<target_url>
    // This routes the request through ST's Node.js server, bypassing browser CORS.
    return `/cors/${url}`;
}

/**
 * Get standard request headers including ST's CSRF token if available.
 * Required when routing through ST's /cors/ proxy.
 * @returns {object}
 */
function getProxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') {
            return ctx.getRequestHeaders();
        }
    } catch (e) { /* fallback */ }
    return { 'Content-Type': 'application/json' };
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Send a summarization request using the configured connection.
 * @param {object} settings - The extension settings containing connection config
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} - The generated response text
 * @throws {Error} - If the request fails
 */
export async function sendSummarizerRequest(settings, systemPrompt, userPrompt) {
    const source = settings.connectionSource || 'default';

    switch (source) {
        case 'profile':
            return await sendViaProfile(settings.connectionProfileId, systemPrompt, userPrompt);
        case 'ollama':
            return await sendViaOllama(settings.ollamaUrl, settings.ollamaModel, systemPrompt, userPrompt);
        case 'openai':
            return await sendViaOpenAI(settings.openaiUrl, settings.openaiKey, settings.openaiModel, systemPrompt, userPrompt);
        case 'default':
        default:
            return await sendViaDefault(systemPrompt, userPrompt);
    }
}

// ─── Mode 1: Default (generateRaw) ──────────────────────────────────

/**
 * Uses ST's built-in generateRaw(), which routes through the active connection.
 */
async function sendViaDefault(systemPrompt, userPrompt) {
    const { generateRaw } = SillyTavern.getContext();

    if (!generateRaw) {
        throw new Error('generateRaw is not available in the current SillyTavern context.');
    }

    const result = await generateRaw({
        systemPrompt: systemPrompt,
        prompt: userPrompt,
    });

    if (!result || typeof result !== 'string') {
        throw new Error('generateRaw returned an empty or invalid response.');
    }

    return result;
}

// ─── Mode 2: Connection Profile ──────────────────────────────────────

/**
 * Uses ST's ConnectionManagerRequestService to send a request via a saved profile.
 * Requires SillyTavern with PR #3603 merged (March 2025+).
 * Full API key support requires staging with Issue #5348 fix (March 30, 2026+).
 */
async function sendViaProfile(profileId, systemPrompt, userPrompt) {
    if (!profileId) {
        throw new Error('No Connection Profile selected. Please select one in Summaryception settings.');
    }

    const context = SillyTavern.getContext();
    const service = context.ConnectionManagerRequestService;

    if (!service) {
        throw new Error(
            'ConnectionManagerRequestService is not available. ' +
            'Your SillyTavern version may be too old. Requires ST with PR #3603 (March 2025+).'
        );
    }

    if (typeof service.sendRequest !== 'function') {
        throw new Error(
            'ConnectionManagerRequestService.sendRequest() is not available. ' +
            'Please update SillyTavern to the latest staging version.'
        );
    }

    try {
        const raw = await service.sendRequest(profileId, {
            systemPrompt: systemPrompt,
            prompt: userPrompt,
            ignoreInstruct: true,
        });

        // Debug: log what we actually got back
        console.log('[Summaryception][Connection] Profile sendRequest returned:', typeof raw, raw);

        // Handle various possible return types
        let result;
        if (typeof raw === 'string') {
            result = raw;
        } else if (raw?.content) {
            result = raw.content;
        } else if (raw?.message?.content) {
            result = raw.message.content;
        } else if (raw?.choices?.[0]?.message?.content) {
            result = raw.choices[0].message.content;
        } else if (raw?.data) {
            result = typeof raw.data === 'string' ? raw.data : JSON.stringify(raw.data);
        } else if (raw && typeof raw === 'object') {
            // Last resort: try to find any string value
            const str = JSON.stringify(raw);
            console.warn('[Summaryception][Connection] Unexpected return type from sendRequest:', str.substring(0, 500));
            throw new Error(
                `Connection Profile returned unexpected type: ${typeof raw}. ` +
                `Preview: ${str.substring(0, 200)}. ` +
                `Please report this on the Summaryception GitHub.`
            );
        } else {
            throw new Error('Connection Profile returned an empty or invalid response.');
        }

        if (!result || !result.trim()) {
            throw new Error('Connection Profile returned an empty response.');
        }

        return result;

    } catch (error) {
        const msg = error?.message || String(error);

        if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
            throw new Error(
                `Connection Profile auth failed (401). This may be the API key switching bug (ST Issue #5348). ` +
                `Update SillyTavern to staging (March 30, 2026+). Original: ${msg}`
            );
        }

        if (msg.includes('not found') || msg.includes('profile')) {
            throw new Error(
                `Connection Profile "${profileId}" not found. It may have been deleted. ` +
                `Please re-select a profile in Summaryception settings.`
            );
        }

        throw new Error(`Connection Profile request failed: ${msg}`);
    }
}

// ─── Mode 3: Ollama (Local) ─────────────────────────────────────────

/**
 * Send a request to a local Ollama instance using /api/chat.
 * Routes through ST's CORS proxy to avoid browser CORS restrictions.
 */
async function sendViaOllama(url, model, systemPrompt, userPrompt) {
    if (!url) {
        throw new Error('Ollama URL is not configured. Please set it in Summaryception settings.');
    }
    if (!model) {
        throw new Error('Ollama model is not selected. Please select one in Summaryception settings.');
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/chat`;

    // Try CORS proxy first, fall back to direct
    let response;
    try {
        response = await fetch(proxiedUrl(targetUrl), {
            method: 'POST',
            headers: {
                ...getProxyHeaders(),
                               'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
                options: {
                    temperature: 0.3,
                },
            }),
        });
    } catch (proxyError) {
        // If CORS proxy failed, try direct (might work if Ollama has CORS configured)
        console.warn(`${MODULE_NAME} CORS proxy failed, trying direct:`, proxyError.message);
        try {
            response = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    stream: false,
                    options: { temperature: 0.3 },
                }),
            });
        } catch (directError) {
            throw new Error(
                `Failed to connect to Ollama at ${baseUrl}. ` +
                `CORS proxy error: ${proxyError.message}. Direct error: ${directError.message}. ` +
                `Make sure enableCorsProxy is set to true in config.yaml, or set OLLAMA_ORIGINS=* on your Ollama instance.`
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Ollama request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (!data?.message?.content) {
        throw new Error('Ollama returned an empty or invalid response.');
    }

    return data.message.content;
}

/**
 * Fetch available models from an Ollama instance.
 * @param {string} url - The Ollama base URL
 * @returns {Promise<Array<{name: string, size: number, modified_at: string}>>}
 */
export async function fetchOllamaModels(url) {
    if (!url) {
        throw new Error('Ollama URL is not configured.');
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/tags`;

    let response;
    try {
        response = await fetch(proxiedUrl(targetUrl), {
            method: 'GET',
            headers: getProxyHeaders(),
        });
    } catch (proxyError) {
        console.warn(`${MODULE_NAME} CORS proxy failed for model list, trying direct:`, proxyError.message);
        try {
            response = await fetch(targetUrl, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (directError) {
            throw new Error(
                `Failed to connect to Ollama at ${baseUrl}. ` +
                `Enable the CORS proxy in config.yaml (enableCorsProxy: true) or set OLLAMA_ORIGINS=* on your Ollama instance. ` +
                `Proxy error: ${proxyError.message}. Direct error: ${directError.message}`
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Failed to fetch Ollama models (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (!data?.models || !Array.isArray(data.models)) {
        throw new Error('Unexpected response format from Ollama /api/tags.');
    }

    return data.models;
}

// ─── Mode 4: OpenAI Compatible ──────────────────────────────────────

/**
 * Send a request to any OpenAI-compatible endpoint.
 * Routes through ST's CORS proxy for local endpoints.
 * Cloud endpoints (detected by URL) skip the proxy since they have CORS headers.
 */
async function sendViaOpenAI(url, apiKey, model, systemPrompt, userPrompt) {
    if (!url) {
        throw new Error('OpenAI Compatible URL is not configured. Please set it in Summaryception settings.');
    }
    if (!model) {
        throw new Error('OpenAI Compatible model name is not set. Please enter one in Summaryception settings.');
    }

    const baseUrl = url.replace(/\/+$/, '');

    // Build the endpoint URL
    let endpoint = baseUrl;
    if (!endpoint.endsWith('/chat/completions')) {
        if (endpoint.endsWith('/v1')) {
            endpoint += '/chat/completions';
        } else if (!endpoint.includes('/chat/completions')) {
            endpoint += '/v1/chat/completions';
        }
    }

    // Decide whether to use CORS proxy:
    // - Local endpoints (localhost, 127.0.0.1, 192.168.x.x) → use proxy
    // - Cloud endpoints (openrouter.ai, api.openai.com, etc.) → skip proxy (they have CORS)
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i.test(endpoint);

    const headers = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 800,
    });

    let response;
    if (isLocal) {
        // Local endpoint: try CORS proxy, fall back to direct
        try {
            response = await fetch(proxiedUrl(endpoint), {
                method: 'POST',
                headers: { ...getProxyHeaders(), ...headers },
                                   body: body,
            });
        } catch (proxyError) {
            console.warn(`${MODULE_NAME} CORS proxy failed for OpenAI endpoint, trying direct:`, proxyError.message);
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers: headers,
                    body: body,
                });
            } catch (directError) {
                throw new Error(
                    `Failed to connect to ${baseUrl}. ` +
                    `Enable the CORS proxy in config.yaml (enableCorsProxy: true). ` +
                    `Proxy error: ${proxyError.message}. Direct error: ${directError.message}`
                );
            }
        }
    } else {
        // Cloud endpoint: direct fetch (should have CORS headers)
        response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: body,
        });
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        if (response.status === 401) {
            throw new Error('OpenAI Compatible endpoint returned 401 Unauthorized. Check your API key.');
        }
        throw new Error(`OpenAI Compatible request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (!data?.choices?.[0]?.message?.content) {
        throw new Error('OpenAI Compatible endpoint returned an empty or invalid response.');
    }

    return data.choices[0].message.content;
}

/**
 * Test the connection to an OpenAI-compatible endpoint.
 * @param {string} url
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testOpenAIConnection(url, apiKey, model) {
    try {
        const result = await sendViaOpenAI(
            url,
            apiKey,
            model || 'test',
            'You are a test assistant.',
            'Respond with exactly: CONNECTION_OK'
        );
        return {
            success: true,
            message: `Connection successful! Response: "${result.substring(0, 100)}"`,
        };
    } catch (error) {
        return {
            success: false,
            message: `Connection failed: ${error.message}`,
        };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Populate a <select> element with connection profiles using ST's built-in handler.
 * @param {HTMLSelectElement} selectElement - The dropdown to populate
 * @param {string} currentValue - The currently selected profile ID
 * @returns {boolean} - Whether population succeeded
 */
export function populateProfileDropdown(selectElement, currentValue) {
    try {
        const context = SillyTavern.getContext();
        const service = context.ConnectionManagerRequestService;

        if (service && typeof service.handleDropdown === 'function') {
            service.handleDropdown(selectElement);
            if (currentValue) {
                selectElement.value = currentValue;
            }
            return true;
        }

        console.warn(`${MODULE_NAME} handleDropdown not available.`);
        return false;
    } catch (error) {
        console.error(`${MODULE_NAME} Error populating profile dropdown:`, error);
        return false;
    }
}

/**
 * Get a human-readable name for the current connection source.
 * @param {object} settings
 * @returns {string}
 */
export function getConnectionDisplayName(settings) {
    switch (settings.connectionSource) {
        case 'default':
            return 'Default (Main API)';
        case 'profile':
            return `Profile: ${settings.connectionProfileId || '(none)'}`;
        case 'ollama':
            return `Ollama: ${settings.ollamaModel || '(no model)'}`;
        case 'openai':
            return `OpenAI: ${settings.openaiModel || '(no model)'}`;
        default:
            return 'Default (Main API)';
    }
}