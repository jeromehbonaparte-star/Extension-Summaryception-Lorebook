/**
 * Lorebook integration for Summaryception.
 *
 * Responsibilities:
 *   - Extract NEW: / UPDATE: tags from Layer-0 snippets
 *   - Generate structured lorebook entries via a second LLM call
 *   - Stage proposals in a per-chat review queue (chatMetadata[MODULE].reviewQueue)
 *   - Commit approved entries to a SillyTavern World Info file
 *
 * The queue storage lives in chatMetadata so it persists per-chat.
 * Settings live in extensionSettings (shared with the summarizer core).
 */

import { sendSummarizerRequest } from './connectionutil.js';

// ST's World Info module lives at public/scripts/world-info.js
// Extension path is public/scripts/extensions/third-party/<ext>/ so we go up 3.
import {
    loadWorldInfo,
    saveWorldInfo,
    createWorldInfoEntry,
    world_names,
} from '../../../world-info.js';

import {
    DEFAULT_ENTRY_PROMPT_CHARACTER,
    DEFAULT_ENTRY_PROMPT_LOCATION,
    DEFAULT_ENTRY_PROMPT_FACTION,
    DEFAULT_ENTRY_PROMPT_ITEM,
    DEFAULT_ENTRY_PROMPT_UPDATE,
    DEFAULT_ENTRY_SYSTEM_PROMPT,
} from './entry-prompts.js';

const LOG = '[Summaryception/Lorebook]';

// ─── Settings shape (merged into defaultSettings in index.js) ────────

export const LOREBOOK_DEFAULT_SETTINGS = Object.freeze({
    lorebookEnabled: false,
    lorebookTargetName: '',              // world_info file name, '' = not configured
    lorebookMode: 'queue',               // 'queue' | 'auto'
    lorebookEntryVectorized: true,
    lorebookEntryConstant: false,
    lorebookEntrySelective: true,

    entryPromptSystem: DEFAULT_ENTRY_SYSTEM_PROMPT,
    entryPromptCharacter: DEFAULT_ENTRY_PROMPT_CHARACTER,
    entryPromptLocation:  DEFAULT_ENTRY_PROMPT_LOCATION,
    entryPromptFaction:   DEFAULT_ENTRY_PROMPT_FACTION,
    entryPromptItem:      DEFAULT_ENTRY_PROMPT_ITEM,
    entryPromptUpdate:    DEFAULT_ENTRY_PROMPT_UPDATE,
});

// ─── Tag extraction ──────────────────────────────────────────────────

// Accepts em-dash, en-dash, double-hyphen, or single hyphen as separator.
// Name: any non-separator chars, stops at dash/;|/newline.
// Reason: up to next ; | or newline.
const TAG_REGEX = /(NEW|UPDATE):\s*(char|loc|faction|item):\s*([^\n;|—–]+?)\s*(?:—|–|--|-)\s*([^\n;|]+)/gi;

/**
 * Extract NEW: / UPDATE: tags from a snippet string.
 * @returns {Array<{kind:'create'|'update', entityType:string, name:string, detail:string}>}
 */
export function extractEntityTags(snippetText) {
    if (!snippetText) return [];
    const out = [];
    const seen = new Set();
    TAG_REGEX.lastIndex = 0;
    let m;
    while ((m = TAG_REGEX.exec(snippetText)) !== null) {
        const kindRaw = m[1].toUpperCase();
        const entityType = m[2].toLowerCase();
        const name = m[3].trim();
        const detail = m[4].trim();
        if (!name) continue;
        const dedupKey = `${kindRaw}|${entityType}|${name.toLowerCase()}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        out.push({
            kind: kindRaw === 'NEW' ? 'create' : 'update',
            entityType,
            name,
            detail,
        });
    }
    return out;
}

// ─── Queue management (storage lives in chatMetadata[MODULE].reviewQueue) ──

export function ensureQueue(store) {
    if (!Array.isArray(store.reviewQueue)) {
        store.reviewQueue = [];
    }
    return store.reviewQueue;
}

export function addQueueItem(store, item) {
    const queue = ensureQueue(store);
    queue.push(item);
    return item;
}

export function pendingCount(store) {
    const queue = ensureQueue(store);
    return queue.filter(i => i.status === 'pending').length;
}

export function findQueueItem(store, id) {
    const queue = ensureQueue(store);
    return queue.find(i => i.id === id);
}

export function removeQueueItem(store, id) {
    const queue = ensureQueue(store);
    const idx = queue.findIndex(i => i.id === id);
    if (idx >= 0) queue.splice(idx, 1);
}

function makeId() {
    return 'lb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ─── World Info helpers ──────────────────────────────────────────────

export function listAvailableLorebooks() {
    try {
        return Array.isArray(world_names) ? [...world_names] : [];
    } catch (e) {
        console.warn(LOG, 'world_names unavailable:', e);
        return [];
    }
}

/**
 * Find an existing entry in a lorebook whose key[] (or comment) matches the given name.
 * Case-insensitive; trims whitespace.
 * @returns {{data:object, entry:object}|null}
 */
export async function findExistingEntry(lorebookName, entityName) {
    if (!lorebookName || !entityName) return null;
    const data = await loadWorldInfo(lorebookName);
    if (!data || !data.entries) return null;

    const needle = entityName.trim().toLowerCase();
    for (const uid of Object.keys(data.entries)) {
        const entry = data.entries[uid];
        if (!entry) continue;
        const keys = Array.isArray(entry.key) ? entry.key : [];
        if (keys.some(k => String(k).trim().toLowerCase() === needle)) {
            return { data, entry };
        }
        // Fallback: match against comment (title)
        if (entry.comment && String(entry.comment).trim().toLowerCase() === needle) {
            return { data, entry };
        }
    }
    return null;
}

// ─── Entity-entry generation via LLM ─────────────────────────────────

function promptForEntityType(settings, entityType) {
    switch (entityType) {
        case 'char':    return settings.entryPromptCharacter || DEFAULT_ENTRY_PROMPT_CHARACTER;
        case 'loc':     return settings.entryPromptLocation  || DEFAULT_ENTRY_PROMPT_LOCATION;
        case 'faction': return settings.entryPromptFaction   || DEFAULT_ENTRY_PROMPT_FACTION;
        case 'item':    return settings.entryPromptItem      || DEFAULT_ENTRY_PROMPT_ITEM;
        default:        return settings.entryPromptCharacter || DEFAULT_ENTRY_PROMPT_CHARACTER;
    }
}

function fillPromptTemplate(tpl, vars) {
    let out = tpl;
    for (const [k, v] of Object.entries(vars)) {
        out = out.split('{{' + k + '}}').join(v ?? '');
    }
    return out;
}

/**
 * Call the summarizer LLM with the entity-generation prompt. Reuses the same
 * connection stack as the core summarizer (default / profile / ollama / openai).
 * @returns {Promise<string>} prose body of the entry, or '' on failure.
 */
export async function generateEntryBody({ settings, playerName, tag, sourceSnippet }) {
    const tpl = promptForEntityType(settings, tag.entityType);
    const userPrompt = fillPromptTemplate(tpl, {
        player_name: playerName,
        entity_name: tag.name,
        entity_type: tag.entityType,
        gloss: tag.detail || '',
        source_snippet: sourceSnippet || '',
        change_reason: '',
        existing_entry: '',
    });
    const systemPrompt = settings.entryPromptSystem || DEFAULT_ENTRY_SYSTEM_PROMPT;

    try {
        const result = await sendSummarizerRequest(settings, systemPrompt, userPrompt);
        return (result || '').trim();
    } catch (e) {
        console.error(LOG, 'generateEntryBody failed:', e);
        return '';
    }
}

/**
 * Produce a revised entry body that integrates an UPDATE reason into the existing content.
 */
export async function generateUpdatedEntryBody({ settings, playerName, tag, sourceSnippet, existingContent }) {
    const tpl = settings.entryPromptUpdate || DEFAULT_ENTRY_PROMPT_UPDATE;
    const userPrompt = fillPromptTemplate(tpl, {
        player_name: playerName,
        entity_name: tag.name,
        entity_type: tag.entityType,
        gloss: '',
        source_snippet: sourceSnippet || '',
        change_reason: tag.detail || '',
        existing_entry: existingContent || '',
    });
    const systemPrompt = settings.entryPromptSystem || DEFAULT_ENTRY_SYSTEM_PROMPT;

    try {
        const result = await sendSummarizerRequest(settings, systemPrompt, userPrompt);
        return (result || '').trim();
    } catch (e) {
        console.error(LOG, 'generateUpdatedEntryBody failed:', e);
        return '';
    }
}

// ─── Ingestion pipeline (called from summarizeOneBatch on every Layer-0 snippet) ──

/**
 * Scan a snippet for NEW:/UPDATE: tags. For each tag:
 *   - CREATE: generate entry body, check for existing entry in target lorebook.
 *     If an entry already exists → convert this to an 'update' proposal.
 *     Otherwise → stage as 'create' proposal.
 *   - UPDATE: look up existing entry, generate merged body, stage as 'update'.
 *
 * Proposals go into store.reviewQueue with status='pending'.
 *
 * This function is defensive: any thrown error is logged and swallowed so the
 * summarization pipeline is never broken by lorebook failures.
 *
 * @param {Object} args
 * @param {string} args.snippetText       The Layer-0 snippet that was just produced
 * @param {Array<number>} args.turnRange  [startIdx, endIdx] of source chat turns
 * @param {object} args.settings          Extension settings (getSettings() result)
 * @param {object} args.store             Chat store (getChatStore() result)
 * @param {string} args.playerName        Active persona name
 */
export async function ingestSnippet({ snippetText, turnRange, settings, store, playerName }) {
    if (!settings.lorebookEnabled) return;

    let tags;
    try {
        tags = extractEntityTags(snippetText);
    } catch (e) {
        console.error(LOG, 'tag extraction failed:', e);
        return;
    }

    if (tags.length === 0) return;

    const target = settings.lorebookTargetName;
    if (!target) {
        console.warn(LOG, `${tags.length} tag(s) detected but no target lorebook configured — skipping.`);
        return;
    }

    ensureQueue(store);

    for (const tag of tags) {
        try {
            await processTag({ tag, snippetText, turnRange, settings, store, playerName, target });
        } catch (e) {
            console.error(LOG, `Failed to process tag ${tag.kind}/${tag.entityType}/${tag.name}:`, e);
        }
    }
}

async function processTag({ tag, snippetText, turnRange, settings, store, playerName, target }) {
    // Dedup: skip if a pending queue item already exists for this (kind, type, name)
    const queue = ensureQueue(store);
    const dedupKey = `${tag.kind}|${tag.entityType}|${tag.name.toLowerCase()}`;
    if (queue.some(i => i.status === 'pending' && i.dedupKey === dedupKey)) {
        return;
    }

    // Look up existing entry (for UPDATE, or to auto-convert NEW→update on collision)
    let existing = null;
    try {
        existing = await findExistingEntry(target, tag.name);
    } catch (e) {
        console.warn(LOG, `findExistingEntry failed for ${tag.name}:`, e);
    }

    let item;

    if (tag.kind === 'update' || (tag.kind === 'create' && existing)) {
        // UPDATE path: existing entry required.
        if (!existing) {
            console.warn(LOG, `UPDATE tag for ${tag.name} but no existing entry in "${target}". Converting to CREATE.`);
            item = await stageCreate({ tag, snippetText, turnRange, settings, playerName, target, dedupKey });
        } else {
            item = await stageUpdate({ tag, snippetText, turnRange, settings, playerName, target, existing, dedupKey });
        }
    } else {
        // CREATE path: no collision.
        item = await stageCreate({ tag, snippetText, turnRange, settings, playerName, target, dedupKey });
    }

    if (!item) return;

    addQueueItem(store, item);

    if (settings.lorebookMode === 'auto') {
        // Auto-commit: push straight through.
        try {
            await commitReviewItem({ store, id: item.id });
        } catch (e) {
            console.error(LOG, 'auto-commit failed:', e);
        }
    }
}

async function stageCreate({ tag, snippetText, turnRange, settings, playerName, target, dedupKey }) {
    const body = await generateEntryBody({ settings, playerName, tag, sourceSnippet: snippetText });
    if (!body) return null;

    return {
        id: makeId(),
        kind: 'create',
        entityType: tag.entityType,
        name: tag.name,
        detail: tag.detail,
        targetLorebook: target,
        sourceTurnRange: Array.isArray(turnRange) ? [...turnRange] : null,
        sourceSnippetText: snippetText,
        proposedContent: body,
        existingUid: null,
        existingContentSnapshot: null,
        createdAt: Date.now(),
        status: 'pending',
        dedupKey,
    };
}

async function stageUpdate({ tag, snippetText, turnRange, settings, playerName, target, existing, dedupKey }) {
    const existingContent = existing.entry.content || '';
    const body = await generateUpdatedEntryBody({
        settings, playerName, tag, sourceSnippet: snippetText, existingContent,
    });
    if (!body) return null;

    return {
        id: makeId(),
        kind: 'update',
        entityType: tag.entityType,
        name: tag.name,
        detail: tag.detail,
        targetLorebook: target,
        sourceTurnRange: Array.isArray(turnRange) ? [...turnRange] : null,
        sourceSnippetText: snippetText,
        proposedContent: body,
        existingUid: existing.entry.uid,
        existingContentSnapshot: existingContent,
        createdAt: Date.now(),
        status: 'pending',
        dedupKey,
    };
}

// ─── Commit / reject operations ──────────────────────────────────────

/**
 * Write a pending review item to the target World Info file.
 * For 'create': creates a new entry with key=[name], content=proposedContent.
 * For 'update': mutates the existing entry's content, preserving all other fields.
 */
export async function commitReviewItem({ store, id }) {
    const item = findQueueItem(store, id);
    if (!item) throw new Error('Queue item not found: ' + id);
    if (item.status !== 'pending') throw new Error('Item is not pending: ' + item.status);

    const data = await loadWorldInfo(item.targetLorebook);
    if (!data) throw new Error('Could not load lorebook: ' + item.targetLorebook);

    if (item.kind === 'create') {
        const entry = createWorldInfoEntry(item.targetLorebook, data);
        if (!entry) throw new Error('createWorldInfoEntry returned null');
        entry.key = [item.name];
        entry.keysecondary = entry.keysecondary || [];
        entry.content = item.proposedContent;
        entry.comment = `${entityTypeLabel(item.entityType)}: ${item.name}`;
        // Respect user defaults
        const s = __currentSettingsRef?.() || {};
        entry.vectorized = !!s.lorebookEntryVectorized;
        entry.selective  = !!s.lorebookEntrySelective;
        entry.constant   = !!s.lorebookEntryConstant;
        entry.disable    = false;
    } else if (item.kind === 'update') {
        // Find the existing entry by uid
        const existing = data.entries?.[item.existingUid];
        if (!existing) {
            throw new Error(`Existing entry uid=${item.existingUid} not found in "${item.targetLorebook}". The entry may have been deleted.`);
        }
        existing.content = item.proposedContent;
        // Do not touch keys, vectorized, etc.
    } else {
        throw new Error('Unknown item kind: ' + item.kind);
    }

    await saveWorldInfo(item.targetLorebook, data, true);
    item.status = 'approved';
    item.committedAt = Date.now();
    return item;
}

export function rejectReviewItem({ store, id }) {
    const item = findQueueItem(store, id);
    if (!item) return null;
    item.status = 'rejected';
    item.rejectedAt = Date.now();
    return item;
}

export function updateReviewItemContent({ store, id, newContent }) {
    const item = findQueueItem(store, id);
    if (!item) return null;
    item.proposedContent = newContent;
    item.editedAt = Date.now();
    return item;
}

// Settings ref shim so commit can read vectorized/selective/constant defaults
// without importing getSettings() (which would create a circular dep).
let __currentSettingsRef = null;
export function registerSettingsAccessor(fn) {
    __currentSettingsRef = fn;
}

function entityTypeLabel(t) {
    switch (t) {
        case 'char':    return 'Character';
        case 'loc':     return 'Location';
        case 'faction': return 'Faction';
        case 'item':    return 'Item';
        default:        return t;
    }
}
