/**
 * Default prompts for lorebook entry generation.
 *
 * Each prompt receives:
 *   {{player_name}}     — active player/persona name
 *   {{entity_name}}     — the entity's canonical name
 *   {{entity_type}}     — char | loc | faction | item
 *   {{gloss}}           — one-phrase description from the NEW: tag (empty for UPDATE:)
 *   {{source_snippet}}  — the Layer-0 snippet that triggered this ingestion
 *   {{change_reason}}   — what canonically changed (UPDATE only; empty for NEW)
 *   {{existing_entry}}  — the existing WI entry content (UPDATE only)
 *
 * The LLM must output the entry body (prose) ONLY. No preamble, no JSON,
 * no markdown headings. The extension wraps it with key/vectorized/etc.
 */

export const DEFAULT_ENTRY_PROMPT_CHARACTER = `<player_name>{{player_name}}</player_name>
<character_name>{{entity_name}}</character_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_snippet}}</source_passage>

Write a compact character profile for a story lorebook. Inject-on-mention, so establish identity without bloat.

Capture, in order, using only what the source states or strongly implies:
- Physical baseline: build, hair, distinctive features, scars, handedness
- Speech register + verbal tics: how they sound, recurring phrases, accent cues, formality
- Dialogue color (preserve any hex code mentioned verbatim)
- Role / faction / affiliation
- Baseline relationship to {{player_name}} and other characters introduced
- Known skills, capabilities, or defining traits
- Sworn oaths, debts, secrets they carry

Rules:
- Do NOT invent backstory or appearance not present in source.
- Short declarative phrases. Aim for 60–120 words.
- Output the profile body ONLY. No preamble, no JSON, no markdown headings.`;

export const DEFAULT_ENTRY_PROMPT_LOCATION = `<player_name>{{player_name}}</player_name>
<location_name>{{entity_name}}</location_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_snippet}}</source_passage>

Write a compact location profile for a story lorebook.

Capture, in order, using only what the source states or strongly implies:
- Type: city, tavern, forest, ruin, stronghold, etc.
- Distinctive physical features: layout, landmarks, sensory anchors (sound, smell, light)
- Faction control / ownership / inhabitants
- Reputation or common knowledge about the place
- Dangers, secrets, or hidden aspects
- Narrative significance: what happened here, what it means to characters

Rules:
- Do NOT invent geography or history not present in source.
- Short declarative phrases. Aim for 50–100 words.
- Output the profile body ONLY. No preamble, no JSON, no markdown headings.`;

export const DEFAULT_ENTRY_PROMPT_FACTION = `<player_name>{{player_name}}</player_name>
<faction_name>{{entity_name}}</faction_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_snippet}}</source_passage>

Write a compact faction profile for a story lorebook.

Capture, in order, using only what the source states or strongly implies:
- Type: guild, house, cult, military unit, criminal ring, nation, etc.
- Leadership or notable members
- Goals, ideology, or guiding principles
- Methods / reputation / public face vs. private reality
- Allies and enemies (especially relative to {{player_name}})
- Distinguishing marks: sigil, colors, oaths, rituals
- Current activity or narrative role

Rules:
- Do NOT invent hierarchy or history not present in source.
- Short declarative phrases. Aim for 50–100 words.
- Output the profile body ONLY. No preamble, no JSON, no markdown headings.`;

export const DEFAULT_ENTRY_PROMPT_ITEM = `<player_name>{{player_name}}</player_name>
<item_name>{{entity_name}}</item_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_snippet}}</source_passage>

Write a compact item profile for a story lorebook. Only note items with narrative weight: magical, cursed, heirloom, keyed to a plot, or otherwise tracked.

Capture, in order, using only what the source states or strongly implies:
- Type: weapon, artifact, tool, document, etc.
- Physical description: appearance, material, distinctive marks
- Powers, properties, or effects
- Origin or provenance (who made it, where it came from)
- Current owner/wielder and how they acquired it
- Known curses, costs, or restrictions
- Narrative significance or plot hooks

Rules:
- Do NOT invent powers or history not present in source.
- Short declarative phrases. Aim for 40–90 words.
- Output the profile body ONLY. No preamble, no JSON, no markdown headings.`;

export const DEFAULT_ENTRY_PROMPT_UPDATE = `<player_name>{{player_name}}</player_name>
<entity_name>{{entity_name}}</entity_name>
<entity_type>{{entity_type}}</entity_type>
<change_reason>{{change_reason}}</change_reason>
<source_passage>{{source_snippet}}</source_passage>

<existing_entry>
{{existing_entry}}
</existing_entry>

The existing lorebook entry for {{entity_name}} is now outdated. The source_passage records a canonical change: {{change_reason}}.

Produce a revised entry that:
- Preserves every load-bearing fact from <existing_entry> that is NOT contradicted by the change.
- Integrates the canonical change cleanly (not appended as "UPDATE: ..." — rewrite affected sentences as if this were always true).
- Adds no detail absent from the source or the existing entry.
- Retains the existing structure, length, and tone of <existing_entry>.

Output the revised profile body ONLY. No preamble, no JSON, no markdown headings, no diff markers.`;

export const DEFAULT_ENTRY_SYSTEM_PROMPT =
    'You are a precise lorebook writer. You extract canonical facts from story passages and produce dense, specific entries. You output ONLY the entry body — no preamble, no commentary, no markdown wrappers.';
