/**
 * WikiFace: Wikipedia Plot Character Switcher
 * --------------------------------------------
 * Content script. Runs on every *.wikipedia.org/wiki/* page and, when the
 * article has both a Plot-like section and a Cast-like section, injects a
 * three-way toggle above the plot:
 *
 *   [ 👤 Characters | 🎭 Actors | 🖼️ Faces ]
 *
 * Pipeline (each stage is a small module below):
 *
 *   Sections   → find the Plot and Cast sections (Vector 2022, legacy
 *                Vector/MonoBook/Timeless, Minerva mobile, Parsoid <section>)
 *   CastParser → turn cast list items / tables into {actor, actorTitle, character}
 *   Cast       → merge duplicates into a character roster with stable colours
 *   Aliases    → derive safe match strings per character (full name, last
 *                name, "Dr. Grant", nicknames…) and drop ambiguous ones
 *   Tokenizer  → walk plot TEXT NODES only and wrap matches in
 *                <span class="wikiface-entity">, never touching innerHTML
 *   Images     → batch PageImages API lookups, cached in memory and
 *                chrome.storage.local
 *   Avatars / Tooltip / Toggle → UI
 *   Controller → wires everything together
 *
 * Mode switching is driven by a single attribute on <html>
 * (data-wikiface-mode). Every entity span already contains all three
 * renderings, so switching modes is one attribute write and the CSS does the
 * rest: no DOM churn, no re-tokenizing, and links/refs are never rebuilt.
 */
(() => {
  'use strict';

  // Content scripts can be injected twice (e.g. extension reload); bail out.
  if (window.__wikifaceInjected) return;
  window.__wikifaceInjected = true;

  /* =========================================================================
   * 1. Configuration
   * ========================================================================= */

  const CONFIG = {
    // Section anchors, tried in order. Wikipedia uses the heading text with
    // spaces replaced by underscores as the id.
    PLOT_IDS: ['Plot', 'Plot_summary', 'Synopsis', 'Plot_synopsis', 'Summary', 'Premise', 'Story', 'Storyline'],
    PLOT_TEXT: /^(plot( summary| synopsis)?|synopsis|summary|premise|story(line)?)$/i,
    CAST_IDS: ['Cast', 'Cast_and_characters', 'Main_cast', 'Principal_cast', 'Voice_cast', 'Characters', 'Starring', 'Cast_and_crew'],
    CAST_TEXT: /^((main |principal |voice )?cast( and (characters|crew))?|characters|starring)$/i,

    THUMB_SIZE: 100,                       // px, as requested from PageImages
    API_BATCH: 50,                         // MediaWiki max titles per query
    CACHE_KEY: 'wikiface_img_cache_v1',
    MODE_KEY: 'wikiface_mode_v1',
    CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000, // one week
    CACHE_MAX: 1500,                       // entries kept in storage
    MODES: ['characters', 'actors', 'faces'],
    DEFAULT_MODE: 'characters',
    DEBUG: false,
  };

  const log = (...args) => { if (CONFIG.DEBUG) console.info('[WikiFace]', ...args); };

  /* =========================================================================
   * 2. Vocabulary used by the alias builder
   * ========================================================================= */

  // Honorifics / ranks. Stripped from the front of character names, and a
  // capitalised title right before a surname blocks partial matching.
  const TITLES = new Set([
    'mr', 'mrs', 'ms', 'miss', 'mister', 'dr', 'doctor', 'prof', 'professor', 'detective', 'det',
    'agent', 'officer', 'sergeant', 'sgt', 'lieutenant', 'lt', 'captain', 'capt', 'cpt', 'major',
    'colonel', 'col', 'general', 'gen', 'admiral', 'commander', 'cmdr', 'chief', 'inspector',
    'constable', 'sheriff', 'deputy', 'judge', 'senator', 'president', 'governor', 'mayor', 'sir',
    'dame', 'lady', 'lord', 'king', 'queen', 'prince', 'princess', 'duke', 'duchess', 'count',
    'countess', 'baron', 'baroness', 'emperor', 'empress', 'father', 'fr', 'sister', 'brother',
    'mother', 'reverend', 'rev', 'pastor', 'rabbi', 'uncle', 'aunt', 'auntie', 'grandma', 'grandpa',
    'nurse', 'coach', 'private', 'pvt', 'corporal', 'cpl', 'marshal', 'ambassador', 'master',
    'madame', 'mme', 'monsieur', 'señor', 'senor', 'señora', 'senora', 'ensign', 'commodore',
  ]);

  const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'esq']);

  // Single words that must never be matched on their own: months, days,
  // pronouns, colours, nationalities, generic nouns and the titles above.
  // (A character literally named "Mother" is still matched, but only
  // mid-sentence; see Aliases.build.)
  const BLOCKED_SINGLE = new Set([
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
    'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'the', 'a', 'an', 'he', 'she', 'it', 'they', 'i', 'we', 'you', 'his', 'her', 'him', 'them',
    'god', 'christmas', 'easter', 'mom', 'mum', 'dad', 'baby', 'kid', 'man', 'woman', 'boy', 'girl',
    'new', 'old', 'young', 'little', 'big', 'long', 'great', 'black', 'white', 'brown', 'green', 'gray',
    'grey', 'red', 'blue', 'gold', 'silver', 'north', 'south', 'east', 'west', 'america', 'american',
    'english', 'british', 'french', 'german', 'russian', 'chinese', 'japanese', 'earth', 'moon', 'sun',
    'death', 'love', 'time', 'city', 'town', 'house', 'home', 'one', 'two', 'number', 'first', 'last',
    'unknown', 'narrator', 'police', 'army', 'navy', 'doc', 'boss', 'kid', 'stranger',
    ...TITLES,
  ]);

  // Real first names that are also everyday English words. Matched only
  // mid-sentence, where a capitalised "Will" or "Mark" is almost always a name.
  const AMBIGUOUS_SINGLE = new Set([
    'will', 'mark', 'grace', 'hope', 'faith', 'joy', 'rose', 'bill', 'pat', 'sue', 'rob', 'art', 'ray',
    'dawn', 'frank', 'chase', 'hunter', 'rich', 'jack', 'pierce', 'lily', 'ivy', 'daisy', 'holly',
    'iris', 'violet', 'ruby', 'amber', 'crystal', 'pearl', 'penny', 'sandy', 'rusty', 'dusty', 'sunny',
    'misty', 'lucky', 'rocky', 'buddy', 'bud', 'cash', 'dash', 'gene', 'glen', 'dale', 'cliff', 'heath',
    'lane', 'page', 'price', 'sterling', 'stone', 'rock', 'river', 'storm', 'sky', 'summer', 'autumn',
    'winter', 'spring', 'melody', 'harmony', 'destiny', 'trinity', 'mercy', 'charity', 'liberty',
    'justice', 'honor', 'patience', 'prudence', 'constance', 'bishop', 'cook', 'fisher', 'mason',
    'miller', 'hall', 'wood', 'bush', 'christian', 'angel', 'honey', 'ginger', 'candy', 'sugar',
    'champ', 'ace', 'earl', 'baker', 'guy', 'don', 'drew', 'carol', 'bob', 'rod', 'gale', 'brook',
  ]);

  // Cast entries that aren't real characters.
  const CHARACTER_STOP = /^(himself|herself|themselves|themself|itself|various( roles| characters)?|uncredited|cameo|additional voices|narrator)$/i;

  /* =========================================================================
   * 3. Small utilities
   * ========================================================================= */

  const Util = {
    /** Collapse whitespace (incl. NBSP) and trim. */
    normSpace: (s) => s.replace(/[\s ]+/g, ' ').trim(),

    /** Lookup key for alias matching: whitespace + curly apostrophes normalised. */
    normKey: (s) => Util.normSpace(s).replace(/[’‘]/g, "'"),

    escapeRe: (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),

    /** Token without trailing period, lower-cased ("Dr." → "dr"). */
    bare: (t) => t.replace(/\.$/, '').toLowerCase(),

    /** Two-letter initials for fallback avatars. */
    initials(name) {
      const parts = Util.normSpace(name.replace(/\(.*?\)/g, ''))
        .split(' ')
        .filter((p) => /^\p{L}/u.test(p) && !NAME_SUFFIXES.has(Util.bare(p)));
      if (!parts.length) return '?';
      const first = parts[0][0];
      const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
      return (first + last).toUpperCase();
    },

    /** Per-wiki cache namespace; en.m.wikipedia.org and en.wikipedia.org share one. */
    siteKey: () => location.hostname.replace('.m.', '.'),

    /**
     * Convert an <a href> into a Wikipedia article title, or null for
     * red links, other namespaces (File:, Category:…) and external links.
     */
    titleFromHref(href) {
      if (!href) return null;
      let url;
      try { url = new URL(href, location.href); } catch { return null; }
      if (!/(^|\.)wikipedia\.org$/.test(url.hostname)) return null;
      const i = url.pathname.indexOf('/wiki/');
      if (i !== 0) return null;
      let raw;
      try { raw = decodeURIComponent(url.pathname.slice(6)); } catch { return null; }
      if (!raw) return null;
      if (/^(file|image|media|category|help|wikipedia|wp|template|special|portal|talk|user|draft|module|mediawiki|wiktionary|[^:]+ talk):/i.test(raw)) return null;
      return raw.replace(/_/g, ' ');
    },
  };

  /** Promise wrapper around chrome.storage.local that degrades to a no-op. */
  const Store = {
    area() {
      try {
        return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
      } catch {
        return null; // "Extension context invalidated" after a reload
      }
    },
    async get(key) {
      const a = this.area();
      if (!a) return undefined;
      try { return (await a.get(key))[key]; } catch { return undefined; }
    },
    async set(key, value) {
      const a = this.area();
      if (!a) return;
      try { await a.set({ [key]: value }); } catch { /* quota or invalidated: ignore */ }
    },
  };

  /* =========================================================================
   * 4. Section locator
   * ========================================================================= */

  const Sections = {
    /**
     * Heading level for an element, or 0 if it isn't a heading.
     * Handles both Vector 2022's <div class="mw-heading mw-heading2"><h2>
     * wrapper and bare <h2> elements from older skins.
     */
    levelOf(el) {
      if (!el || el.nodeType !== 1) return 0;
      if (el.classList.contains('mw-heading')) {
        const m = el.className.match(/\bmw-heading([1-6])\b/);
        if (m) return Number(m[1]);
        const h = el.querySelector('h1, h2, h3, h4, h5, h6');
        return h ? Number(h.tagName[1]) : 0;
      }
      return /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : 0;
    },

    contentRoot() {
      return document.querySelector('#mw-content-text > .mw-parser-output')
        || document.querySelector('#mw-content-text .mw-parser-output')
        || document.querySelector('.mw-parser-output');
    },

    /**
     * Find a section heading by anchor id first (fast and exact), then by
     * visible heading text as a fallback.
     *   Vector 2022: <h2 id="Plot">Plot</h2>
     *   Legacy:      <h2><span class="mw-headline" id="Plot">Plot</span></h2>
     */
    findHeading(root, ids, textRe) {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el || !root.contains(el)) continue;
        const h = el.closest('h1, h2, h3, h4, h5, h6');
        if (h) return h;
      }
      for (const h of root.querySelectorAll('h2, h3')) {
        const labelEl = h.querySelector('.mw-headline') || h;
        const label = Util.normSpace(labelEl.textContent.replace(/\[\s*edit\s*\]/gi, ''));
        if (textRe.test(label)) return h;
      }
      return null;
    },

    /** The element that sits in the content flow for a heading. */
    blockFor(h) {
      const p = h.parentElement;
      return p && p.classList.contains('mw-heading') ? p : h;
    },

    /**
     * Every element belonging to the section, including its subsections,
     * up to the next heading of the same or higher level.
     */
    contentOf(h) {
      const block = this.blockFor(h);
      const level = this.levelOf(block) || Number(h.tagName[1]);
      const parent = block.parentElement;

      // Parsoid-style output wraps each section in <section>.
      if (parent && parent.tagName === 'SECTION' && parent.firstElementChild === block) {
        return Array.from(parent.children).slice(1);
      }

      const out = [];
      for (let n = block.nextElementSibling; n; n = n.nextElementSibling) {
        const l = this.levelOf(n);
        if (l && l <= level) break;
        if (n.tagName === 'SECTION') {
          // Minerva puts content in a <section> after the heading; a <section>
          // that *starts* with a same-level heading is the next section.
          const fl = this.levelOf(n.firstElementChild);
          if (fl && fl <= level) break;
        }
        out.push(n);
      }
      return out;
    },
  };

  /* =========================================================================
   * 5. Cast parser
   * ========================================================================= */

  const CastParser = {
    IGNORE_CONTAINERS: '.navbox, .reflist, .references, .gallery, .hatnote, .sidebar, .infobox, .metadata',

    /** Parse every list item and cast table in the section. */
    parse(nodes) {
      const entries = [];
      for (const node of nodes) {
        if (node.nodeType !== 1 || node.matches(this.IGNORE_CONTAINERS)) continue;

        const items = node.matches('li, dd') ? [node] : node.querySelectorAll('li, dd');
        for (const li of items) {
          if (li.closest(this.IGNORE_CONTAINERS) || li.closest('table.wikitable')) continue;
          entries.push(...this.parseItem(li));
        }

        const tables = node.matches('table.wikitable') ? [node] : node.querySelectorAll('table.wikitable');
        for (const t of tables) entries.push(...this.parseTable(t));
      }
      return entries;
    },

    /**
     * Flatten an element to plain text, skipping nested lists and reference
     * superscripts, and record where each internal article link sits in it.
     * Offsets let us decide which link belongs to the actor's half.
     */
    flatten(el) {
      let text = '';
      const links = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 1) {
            return n !== el && n.matches('ul, ol, dl, sup, .mw-ref, style, script, link, .noprint, .mw-editsection')
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const start = text.length;
        text += n.data.replace(/ /g, ' '); // same length, so offsets hold
        const a = n.parentElement && n.parentElement.closest('a');
        if (a && el.contains(a)) {
          const title = Util.titleFromHref(a.getAttribute('href'));
          if (title) links.push({ start, end: text.length, title });
        }
      }
      return { text, links };
    },

    /** First article link overlapping [from, to) in a flattened string. */
    linkIn(links, from, to) {
      const hit = links.find((l) => l.start < to && l.end > from);
      return hit ? hit.title : null;
    },

    /**
     * Recognised shapes, in priority order:
     *   "Harrison Ford as Rick Deckard, a blade runner…"
     *   "Rick Deckard, played by Harrison Ford"
     *   "Harrison Ford – Rick Deckard"   (actor first; flips if only the right side is linked)
     *   "Rick Deckard (Harrison Ford)"
     */
    parseItem(li) {
      const { text: fullText, links } = this.flatten(li);
      const text = fullText.split('\n')[0];
      if (!text.trim()) return [];

      let actorRaw = null;
      let charRaw = null;
      let actorRange = null;

      const as = /\s+as\s+/.exec(text);
      const dash = /\s+[–—-]\s+/.exec(text);
      const played = /,?\s+(?:played|portrayed|voiced)\s+by\s+/i.exec(text);
      const paren = /^([^()]+?)\s*\(([^()]+)\)/.exec(text);

      if (as && (!dash || as.index < dash.index) && (!played || as.index < played.index)) {
        actorRaw = text.slice(0, as.index);
        charRaw = text.slice(as.index + as[0].length);
        actorRange = [0, as.index];
      } else if (played) {
        charRaw = text.slice(0, played.index);
        const after = played.index + played[0].length;
        actorRaw = text.slice(after);
        actorRange = [after, text.length];
      } else if (dash) {
        const left = [0, dash.index];
        const right = [dash.index + dash[0].length, text.length];
        const leftLinked = this.linkIn(links, ...left);
        const rightLinked = this.linkIn(links, ...right);
        const actorOnRight = !leftLinked && rightLinked;
        actorRange = actorOnRight ? right : left;
        const charRange = actorOnRight ? left : right;
        actorRaw = text.slice(...actorRange);
        charRaw = text.slice(...charRange);
      } else if (paren && !/\b(voice|uncredited|credited|\d{4}|season|episode)/i.test(paren[2])) {
        charRaw = paren[1];
        actorRaw = paren[2];
        const start = paren.index + paren[0].indexOf('(') + 1;
        actorRange = [start, start + paren[2].length];
      } else {
        return [];
      }

      const actor = this.cleanActor(actorRaw);
      if (!actor) return [];
      const actorTitle = this.linkIn(links, ...actorRange);

      return this.cleanCharacters(charRaw)
        .filter((character) => character.toLowerCase() !== actor.toLowerCase())
        .map((character) => ({ actor, actorTitle, character }));
    },

    /** Two-column cast tables: header row names an actor column and a character column. */
    parseTable(table) {
      const rows = Array.from(table.rows || []);
      if (rows.length < 2) return [];
      const heads = Array.from(rows[0].cells).map((c) => Util.normSpace(c.textContent).toLowerCase());
      const ai = heads.findIndex((h) => /\b(actor|actress|cast|performer|played by|portrayed by|voiced by)\b/.test(h));
      const ci = heads.findIndex((h) => /\b(character|role|part)\b/.test(h));
      if (ai < 0 || ci < 0 || ai === ci) return [];

      const out = [];
      for (const row of rows.slice(1)) {
        const cells = row.cells;
        if (cells.length <= Math.max(ai, ci)) continue; // rowspans: skip rather than misalign
        const a = this.flatten(cells[ai]);
        const actor = this.cleanActor(a.text);
        if (!actor) continue;
        const actorTitle = a.links.length ? a.links[0].title : null;
        for (const character of this.cleanCharacters(this.flatten(cells[ci]).text)) {
          out.push({ actor, actorTitle, character });
        }
      }
      return out;
    },

    cleanActor(raw) {
      if (!raw) return null;
      let s = Util.normSpace(raw)
        .replace(/\s*\(.*$/, '')        // "(voice)", "(uncredited)"
        .replace(/[,:;.]+$/, '')
        .replace(/^(and|with)\s+/i, '');
      s = s.trim();
      const words = s.split(' ');
      if (s.length < 2 || s.length > 60 || words.length > 6) return null;
      if (!/^\p{Lu}/u.test(s) || /\d/.test(s)) return null;
      return s;
    },

    /** Turn the text after "as" into one or more clean character names. */
    cleanCharacters(raw) {
      if (!raw) return [];
      let s = Util.normSpace(raw).replace(/^(?:the\s+)?voices?\s+of\s+/i, '');
      s = this.cutDescription(s);
      return s
        .split(/\s+(?:and|&)\s+|\s*\/\s*/)
        .map((part) => this.tidyCharacter(part))
        .filter(Boolean);
    },

    /**
     * Cut at the first clause separator: comma, colon, semicolon, bracket,
     * spaced dash, relative pronoun, or a sentence break that isn't an
     * abbreviation ("Dr. Alan Grant" survives, "John Smith. He…" is cut).
     */
    cutDescription(s) {
      const hard = s.search(/\s*[,:;([]|\s+[–—-]\s+|\s+(?:who|whose|which|that|in|from)\s/);
      let end = hard < 0 ? s.length : hard;
      const re = /\.\s+(?=\p{Lu})/gu;
      for (let m = re.exec(s); m && m.index < end; m = re.exec(s)) {
        const prevToken = s.slice(0, m.index).split(' ').pop();
        if (prevToken.length >= 4 && !TITLES.has(prevToken.toLowerCase())) { end = m.index; break; }
      }
      return s.slice(0, end);
    },

    tidyCharacter(part) {
      let s = Util.normSpace(part)
        .replace(/^["“'‘]+|["”'’]+$/g, '')                        // wrapping quotes
        .replace(/^(?:(?:a|an|the)\s+)?(?:young(?:er)?|teen(?:age)?|older|adult|elderly|child|middle-aged|present-day|future|past)\s+(?=\p{Lu})/u, '')
        .replace(/\.$/, '')
        .trim();
      if (!s || s.length > 60 || s.split(' ').length > 7) return null;
      if (!/^[\p{Lu}\p{N}"“]/u.test(s)) return null;
      if (CHARACTER_STOP.test(s)) return null;
      if (/^(A|An)\s/.test(s)) return null;                          // "A waitress"
      return s;
    },
  };

  /* =========================================================================
   * 6. Cast roster
   * ========================================================================= */

  const Cast = {
    /**
     * Merge parsed entries by character. The first actor listed wins; later
     * ones ("young Jack") are kept as altActors and shown in the tooltip.
     * Hues are spread with the golden angle so neighbours look distinct.
     */
    build(entries) {
      const byKey = new Map();
      for (const e of entries) {
        const key = Util.normKey(e.character).toLowerCase();
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, { ...e, altActors: [] });
        } else if (existing.actor !== e.actor && !existing.altActors.includes(e.actor)) {
          existing.altActors.push(e.actor);
        }
      }
      return Array.from(byKey.values()).map((c, i) => ({
        ...c,
        id: `wf${i}`,
        hue: Math.round((i * 137.508) % 360),
        actorKey: c.actorTitle ? `t:${c.actorTitle}` : `n:${c.actor}`,
      }));
    },
  };

  /* =========================================================================
   * 7. Alias builder
   * ========================================================================= */

  const Aliases = {
    /**
     * For "Detective David Smith" produce:
     *   full     "Detective David Smith"
     *   stripped "David Smith"
     *   titled   "Detective Smith"
     *   first    "David"   (partial)
     *   last     "Smith"   (partial)
     * Partial aliases that point to more than one character (two McFlys) are
     * dropped; single words that are common English are blocked or restricted
     * to mid-sentence use.
     *
     * Returns { map: Map(normKey → alias), regex }.
     */
    build(characters) {
      const candidates = [];
      const add = (text, char, kind) => {
        const t = Util.normSpace(text);
        if (t.length >= 2) candidates.push({ text: t, char, kind });
      };

      for (const c of characters) {
        const name = c.character;
        add(name, c, 'full');

        // Nicknames: Ellis "Red" Redding → "Ellis Redding" + "Red"
        let base = name;
        const nick = name.match(/["“]([^"”]+)["”]/);
        if (nick) {
          base = Util.normSpace(name.replace(nick[0], ' '));
          add(base, c, 'full');
          add(nick[1], c, 'nick');
        }

        // "The Joker" → "the Joker" (mid-sentence form) and "Joker"
        if (/^The \p{Lu}/u.test(base)) {
          add(`the ${base.slice(4)}`, c, 'full');
          add(base.slice(4), c, 'stripped');
        }

        let tokens = base.split(' ');
        const titles = [];
        while (tokens.length > 1 && TITLES.has(Util.bare(tokens[0]))) titles.push(tokens.shift());
        if (titles.length) add(tokens.join(' '), c, 'stripped');

        while (tokens.length > 1 && NAME_SUFFIXES.has(Util.bare(tokens[tokens.length - 1]).replace(/,$/, ''))) tokens.pop();
        if (tokens.length >= 2) {
          const first = tokens[0];
          const last = tokens[tokens.length - 1];
          if (tokens.length >= 3) add(`${first} ${last}`, c, 'stripped');
          if (titles.length) add(`${titles.join(' ')} ${last}`, c, 'titled');
          if (nick) add(`${nick[1]} ${last}`, c, 'stripped');            // "Doc Brown"
          add(first, c, 'first');
          add(last, c, 'last');
        }
      }

      // Group by text and resolve collisions.
      const groups = new Map();
      for (const cand of candidates) {
        const key = Util.normKey(cand.text);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(cand);
      }

      const map = new Map();
      for (const [key, group] of groups) {
        const ids = new Set(group.map((g) => g.char.id));
        let chosen = group[0];
        if (ids.size > 1) {
          // Ambiguous text. Keep it only if it is exactly one character's full name.
          const fulls = group.filter((g) => g.kind === 'full' || g.kind === 'stripped');
          const fullIds = new Set(fulls.map((g) => g.char.id));
          if (fullIds.size !== 1) continue;
          chosen = fulls[0];
        } else {
          // Prefer the strongest kind if one character produced the same text twice.
          chosen = group.find((g) => g.kind === 'full') || group.find((g) => g.kind === 'stripped') || group[0];
        }

        const partial = chosen.kind === 'first' || chosen.kind === 'last' || chosen.kind === 'nick';
        const single = !/\s/.test(key);
        let midOnly = false;

        if (single) {
          const word = Util.bare(key);
          // Names listed verbatim in the cast (incl. quoted nicknames like "Red")
          // count as verified; they're never dropped, only restricted.
          const verified = chosen.kind === 'full' || chosen.kind === 'stripped' || chosen.kind === 'nick';
          if (word.length < 3 && !verified) continue;
          if (BLOCKED_SINGLE.has(word)) {
            if (!verified) continue;
            midOnly = true;
          }
          if (AMBIGUOUS_SINGLE.has(word)) midOnly = true;
          if (!/^\p{Lu}/u.test(key)) continue;
        }

        map.set(key, { text: chosen.text, char: chosen.char, kind: chosen.kind, partial, midOnly });
      }

      if (!map.size) return { map, regex: null };

      // Longest first so "Detective David Smith" wins over "David".
      const sources = Array.from(map.values())
        .sort((a, b) => b.text.length - a.text.length)
        .map((a) => a.text
          .split(' ')
          .map((tok) => Util.escapeRe(tok).replace(/['’]/g, "['’]"))
          .join('[\\s\\u00a0]+'));

      // Unicode-aware word boundaries: \b doesn't understand "Zoë" or "José".
      const regex = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${sources.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
      return { map, regex };
    },
  };

  /* =========================================================================
   * 8. Plot tokenizer (text-node walker; never touches innerHTML)
   * ========================================================================= */

  const Tokenizer = {
    // Never descend into these: refs, math, our own UI, figures, tables…
    SKIP: 'sup, .mw-ref, .reference, style, script, link, .mw-editsection, .wikiface-entity, .wikiface-bar, '
      + 'math, .mwe-math-element, code, pre, .noprint, figure, .thumb, table, .infobox, .hatnote, .navbox, '
      + '.gallery, .reflist, .IPA',
    BLOCKS: 'p, li, dd, blockquote',

    /** Collect outermost text blocks (p/li/dd/blockquote) in the section. */
    blocks(nodes) {
      const found = [];
      for (const n of nodes) {
        if (n.nodeType !== 1 || n.matches(this.SKIP)) continue;
        if (n.matches(this.BLOCKS)) found.push(n);
        else found.push(...n.querySelectorAll(this.BLOCKS));
      }
      return found.filter((b, i) => !b.closest(this.SKIP)
        && !found.some((o, j) => j !== i && o.contains(b)));
    },

    /** Wrap every accepted match. Returns { count, used: Set(charId) }. */
    run(nodes, aliases, onEntity) {
      const used = new Set();
      let count = 0;
      if (!aliases.regex) return { count, used };

      for (const block of this.blocks(nodes)) {
        // Gather text nodes plus their offsets in the block's flattened text,
        // so sentence/neighbour checks can look across <a>/<i> boundaries.
        const parts = [];
        let full = '';
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (n.nodeType === 1
            ? (n.matches(this.SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
            : NodeFilter.FILTER_ACCEPT),
        });
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          parts.push({ node: t, offset: full.length });
          full += t.data;
        }

        for (const { node, offset } of parts) {
          const re = aliases.regex;
          re.lastIndex = 0;
          const hits = [];
          for (let m = re.exec(node.data); m; m = re.exec(node.data)) {
            const alias = aliases.map.get(Util.normKey(m[0]));
            if (!alias) continue;
            const s = offset + m.index;
            if (!this.accept(alias, full, s, s + m[0].length)) continue;
            hits.push({ index: m.index, length: m[0].length, alias });
          }
          // Split from the end so earlier indices stay valid.
          for (let i = hits.length - 1; i >= 0; i--) {
            const h = hits[i];
            const target = node.splitText(h.index);
            target.splitText(h.length);
            target.replaceWith(onEntity(h.alias.char, target.data, h.alias.kind));
            used.add(h.alias.char.id);
            count++;
          }
        }
      }
      return { count, used };
    },

    /** True if position is the start of a sentence/paragraph. */
    atSentenceStart(before) {
      const t = before.replace(/[\s ]+$/, '');
      return !t || /[.!?…:“(]$/.test(t);
    },

    /** Context checks that keep partial and ambiguous aliases honest. */
    accept(alias, full, s, e) {
      const before = full.slice(0, s);
      if (alias.midOnly && this.atSentenceStart(before)) return false;
      if (!alias.partial) return true;

      // "David" followed by another capitalised name ("David Bowie") is someone else.
      if (/^[\s ]+\p{Lu}\p{Ll}/u.test(full.slice(e, e + 30))) return false;

      // "Mrs. Smith" / "Agent Smith" / "Michael Smith": a capitalised word glued
      // in front means a different or unknown person, unless that word simply
      // starts the sentence ("Then Smith…").
      const pm = /(\S+)[\s ]+$/u.exec(before);
      if (pm) {
        const prev = pm[1];
        if (TITLES.has(Util.bare(prev))) return false;
        if (/^\p{Lu}/u.test(prev) && !/[,;:!?)"”’]$/.test(prev) && !/\.$/.test(prev)) {
          if (!this.atSentenceStart(before.slice(0, before.length - pm[0].length))) return false;
        }
      }
      return true;
    },
  };

  /* =========================================================================
   * 9. Image service (PageImages API + two-level cache)
   * ========================================================================= */

  const Images = {
    mem: new Map(),        // cacheKey → { u: url|null, t: timestamp }
    cacheLoaded: false,

    key: (title) => `${Util.siteKey()}|${title}`,

    async loadCache() {
      if (this.cacheLoaded) return;
      this.cacheLoaded = true;
      const stored = await Store.get(CONFIG.CACHE_KEY);
      if (!stored || typeof stored !== 'object') return;
      const now = Date.now();
      for (const [k, v] of Object.entries(stored)) {
        if (v && typeof v.t === 'number' && now - v.t < CONFIG.CACHE_TTL_MS) this.mem.set(k, v);
      }
    },

    async persist() {
      const entries = Array.from(this.mem.entries())
        .sort((a, b) => b[1].t - a[1].t)
        .slice(0, CONFIG.CACHE_MAX);
      await Store.set(CONFIG.CACHE_KEY, Object.fromEntries(entries));
    },

    /**
     * Resolve thumbnails for article titles. Returns Map(title → url|null).
     * "No image" is cached too; network failures are not.
     */
    async resolve(titles) {
      await this.loadCache();
      const out = new Map();
      const need = [];
      for (const t of new Set(titles)) {
        const hit = this.mem.get(this.key(t));
        if (hit) out.set(t, hit.u);
        else need.push(t);
      }

      for (let i = 0; i < need.length; i += CONFIG.API_BATCH) {
        const batch = need.slice(i, i + CONFIG.API_BATCH);
        try {
          const res = await this.fetchBatch(batch);
          for (const t of batch) {
            const u = res.get(t) || null;
            out.set(t, u);
            this.mem.set(this.key(t), { u, t: Date.now() });
          }
        } catch (err) {
          log('PageImages request failed', err);
          for (const t of batch) out.set(t, null);
        }
      }

      if (need.length) this.persist();
      return out;
    },

    /** One PageImages query for up to 50 titles, following normalisation and redirects. */
    async fetchBatch(titles) {
      // Same wiki the reader is on, so fr./de./m. pages work too.
      const url = new URL('/w/api.php', location.origin);
      url.search = new URLSearchParams({
        action: 'query',
        titles: titles.join('|'),
        prop: 'pageimages',
        format: 'json',
        formatversion: '2',
        pithumbsize: String(CONFIG.THUMB_SIZE),
        redirects: '1',
        origin: '*',
      }).toString();

      const res = await fetch(url.toString(), { credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const q = (await res.json()).query || {};

      const normalized = new Map((q.normalized || []).map((n) => [n.from, n.to]));
      const redirects = new Map((q.redirects || []).map((r) => [r.from, r.to]));
      const pageList = Array.isArray(q.pages) ? q.pages : Object.values(q.pages || {});
      const pages = new Map(pageList.map((p) => [p.title, p]));

      const out = new Map();
      for (const t of titles) {
        let cur = normalized.get(t) || t;
        for (let hops = 0; redirects.has(cur) && hops < 3; hops++) cur = redirects.get(cur);
        const p = pages.get(cur);
        out.set(t, p && p.thumbnail ? p.thumbnail.source : null);
      }
      return out;
    },
  };

  /* =========================================================================
   * 10. Avatars (shared by inline chips and the tooltip)
   * ========================================================================= */

  const Avatars = {
    state: new Map(),     // actorKey → { status: 'loading'|'ok'|'none', url }
    registry: new Map(),  // actorKey → Set<HTMLElement>

    create(char, extraClass = '') {
      const el = document.createElement('span');
      el.className = `wf-avatar ${extraClass}`.trim();
      el.setAttribute('aria-hidden', 'true');
      el.style.setProperty('--wf-hue', char.hue);
      if (!this.registry.has(char.actorKey)) this.registry.set(char.actorKey, new Set());
      this.registry.get(char.actorKey).add(el);
      this.paint(el, char);
      return el;
    },

    /** Render one avatar for the actor's current loading state. */
    paint(el, char) {
      const st = this.state.get(char.actorKey) || { status: 'loading' };
      el.classList.toggle('wf-loading', st.status === 'loading');
      el.classList.toggle('wf-initials', st.status === 'none');
      el.textContent = '';
      if (st.status === 'ok') {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = st.url;
        img.addEventListener('error', () => {
          // Broken thumbnail: fall back to initials for every chip of this actor.
          this.set(char, { status: 'none' });
        }, { once: true });
        el.appendChild(img);
      } else if (st.status === 'none') {
        el.textContent = Util.initials(char.actor);
      }
    },

    /** Update state and repaint every avatar (and data-img) for that actor. */
    set(char, st) {
      this.state.set(char.actorKey, st);
      for (const el of this.registry.get(char.actorKey) || []) {
        if (!el.isConnected) continue;
        this.paint(el, char);
        const ent = el.closest('.wikiface-entity');
        if (ent) ent.dataset.img = st.status === 'ok' ? st.url : '';
      }
    },
  };

  /* =========================================================================
   * 11. Entity spans
   * ========================================================================= */

  const Entity = {
    /**
     * <span class="wikiface-entity" data-char data-actor data-img>
     *   <span class="wf-avatar">…</span>        shown in Faces mode
     *   <span class="wf-text-char">Deckard</span>      Characters / Faces
     *   <span class="wf-text-actor">Harrison Ford</span>  Actors
     * </span>
     * The original matched text is preserved verbatim in .wf-text-char.
     */
    create(char, original, kind) {
      const span = document.createElement('span');
      span.className = 'wikiface-entity';
      span.dataset.char = char.character;
      span.dataset.actor = char.actor;
      span.dataset.img = '';
      span.dataset.wfId = char.id;
      span.dataset.alias = kind;
      span.style.setProperty('--wf-hue', char.hue);

      const charText = document.createElement('span');
      charText.className = 'wf-text-char';
      charText.textContent = original;

      const actorText = document.createElement('span');
      actorText.className = 'wf-text-actor';
      actorText.textContent = char.actor;

      span.append(Avatars.create(char), charText, actorText);
      return span;
    },
  };

  /* =========================================================================
   * 12. Tooltip card (one shared element, event delegation)
   * ========================================================================= */

  const Tooltip = {
    el: null,
    current: null,
    showTimer: 0,
    hideTimer: 0,

    init(charsById) {
      this.charsById = charsById;
      const el = document.createElement('div');
      el.className = 'wikiface-tooltip';
      el.id = 'wikiface-tooltip';
      el.setAttribute('role', 'tooltip');
      el.hidden = true;
      el.innerHTML = '<span class="wf-tip-avatar-slot"></span>'
        + '<span class="wf-tip-body"><span class="wf-tip-actor"></span>'
        + '<span class="wf-tip-as">as <strong class="wf-tip-char"></strong></span>'
        + '<span class="wf-tip-alt"></span></span>';
      document.body.appendChild(el);
      this.el = el;

      document.addEventListener('mouseover', (e) => this.onEnter(e.target));
      document.addEventListener('focusin', (e) => this.onEnter(e.target));
      document.addEventListener('mouseout', (e) => this.onLeave(e.target, e.relatedTarget));
      document.addEventListener('focusout', (e) => this.onLeave(e.target, e.relatedTarget));
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(true); });
      window.addEventListener('scroll', () => this.hide(true), { passive: true });
      window.addEventListener('resize', () => this.hide(true), { passive: true });
    },

    /** The entity under a target, including links that wrap an entity. */
    entityFor(target) {
      if (!target || target.nodeType !== 1) return null;
      return target.closest('.wikiface-entity')
        || (target.matches('a') ? target.querySelector('.wikiface-entity') : null);
    },

    onEnter(target) {
      const ent = this.entityFor(target);
      if (!ent) return;
      clearTimeout(this.hideTimer);
      if (ent === this.current && !this.el.hidden) return;
      clearTimeout(this.showTimer);
      this.showTimer = setTimeout(() => this.show(ent), 120);
    },

    onLeave(target, related) {
      const ent = this.entityFor(target);
      if (!ent) return;
      if (related && ent.contains(related)) return;
      clearTimeout(this.showTimer);
      this.hideTimer = setTimeout(() => this.hide(), 80);
    },

    show(ent) {
      const char = this.charsById.get(ent.dataset.wfId);
      if (!char) return;
      this.current = ent;

      const slot = this.el.querySelector('.wf-tip-avatar-slot');
      slot.textContent = '';
      slot.appendChild(Avatars.create(char, 'wf-avatar-lg'));
      this.el.querySelector('.wf-tip-actor').textContent = char.actor;
      this.el.querySelector('.wf-tip-char').textContent = char.character;
      const alt = this.el.querySelector('.wf-tip-alt');
      alt.textContent = char.altActors.length ? `also played by ${char.altActors.join(', ')}` : '';
      alt.hidden = !char.altActors.length;
      this.el.style.setProperty('--wf-hue', char.hue);

      ent.setAttribute('aria-describedby', 'wikiface-tooltip');
      this.el.hidden = false;
      this.position(ent);
      requestAnimationFrame(() => this.el.classList.add('wf-visible'));
    },

    /** Above the name by default (Page Previews open below links); flip if no room. */
    position(ent) {
      const rects = ent.getClientRects();
      const r = rects.length ? rects[0] : ent.getBoundingClientRect();
      const tip = this.el.getBoundingClientRect();
      const gap = 8;
      const vw = document.documentElement.clientWidth;
      let top = r.top - tip.height - gap;
      let placement = 'above';
      if (top < 4) { top = r.bottom + gap; placement = 'below'; }
      let left = r.left + r.width / 2 - tip.width / 2;
      left = Math.max(8, Math.min(left, vw - tip.width - 8));
      this.el.style.top = `${Math.round(top)}px`;
      this.el.style.left = `${Math.round(left)}px`;
      this.el.dataset.placement = placement;
    },

    hide(immediate = false) {
      clearTimeout(this.showTimer);
      if (!this.el || this.el.hidden) return;
      if (this.current) this.current.removeAttribute('aria-describedby');
      this.current = null;
      this.el.classList.remove('wf-visible');
      if (immediate) { this.el.hidden = true; return; }
      setTimeout(() => { if (!this.current) this.el.hidden = true; }, 150);
    },
  };

  /* =========================================================================
   * 13. Segmented toggle (accessible radiogroup)
   * ========================================================================= */

  const Toggle = {
    SEGMENTS: [
      { mode: 'characters', icon: '👤', label: 'Characters' },
      { mode: 'actors', icon: '🎭', label: 'Actors' },
      { mode: 'faces', icon: '🖼️', label: 'Faces' },
    ],

    build({ characterCount, mentionCount, onChange }) {
      const bar = document.createElement('div');
      bar.className = 'wikiface-bar';

      const group = document.createElement('div');
      group.className = 'wikiface-toggle';
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', 'Show names in the plot as');

      const thumb = document.createElement('span');
      thumb.className = 'wf-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      group.appendChild(thumb);

      const buttons = this.SEGMENTS.map((seg) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wf-seg';
        b.dataset.mode = seg.mode;
        b.setAttribute('role', 'radio');
        b.innerHTML = '<span class="wf-seg-icon" aria-hidden="true"></span><span class="wf-seg-label"></span>';
        b.querySelector('.wf-seg-icon').textContent = seg.icon;
        b.querySelector('.wf-seg-label').textContent = seg.label;
        b.addEventListener('click', () => onChange(seg.mode));
        group.appendChild(b);
        return b;
      });

      // Arrow keys move between segments (WAI-ARIA radio group pattern).
      group.addEventListener('keydown', (e) => {
        const i = buttons.indexOf(document.activeElement);
        if (i < 0) return;
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % buttons.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = buttons.length - 1;
        if (next < 0) return;
        e.preventDefault();
        buttons[next].focus();
        onChange(buttons[next].dataset.mode);
      });

      const meta = document.createElement('span');
      meta.className = 'wf-meta';
      meta.textContent = `${characterCount} ${characterCount === 1 ? 'character' : 'characters'} · ${mentionCount} ${mentionCount === 1 ? 'mention' : 'mentions'}`;

      bar.append(group, meta);
      this.bar = bar;
      this.group = group;
      this.thumb = thumb;
      this.buttons = buttons;

      // Keep the sliding thumb aligned when fonts load or the column resizes.
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => this.moveThumb(false)).observe(group);
      }
      return bar;
    },

    update(mode) {
      for (const b of this.buttons) {
        const on = b.dataset.mode === mode;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      this.moveThumb(true);
    },

    moveThumb(animate) {
      const active = this.buttons.find((b) => b.getAttribute('aria-checked') === 'true');
      if (!active) return;
      if (!animate) this.thumb.classList.add('wf-no-anim');
      this.thumb.style.width = `${active.offsetWidth}px`;
      this.thumb.style.transform = `translateX(${active.offsetLeft}px)`;
      if (!animate) requestAnimationFrame(() => this.thumb.classList.remove('wf-no-anim'));
    },

    setBusy(busy) {
      if (this.group) this.group.setAttribute('aria-busy', String(busy));
    },
  };

  /* =========================================================================
   * 14. Controller
   * ========================================================================= */

  const Controller = {
    mode: CONFIG.DEFAULT_MODE,

    setMode(mode, persist = true) {
      if (!CONFIG.MODES.includes(mode)) mode = CONFIG.DEFAULT_MODE;
      this.mode = mode;
      document.documentElement.dataset.wikifaceMode = mode;
      Toggle.update(mode);
      Tooltip.hide(true);
      if (persist) Store.set(CONFIG.MODE_KEY, mode);
    },

    /** Should this page be considered at all? Main namespace, read view only. */
    eligible() {
      const body = document.body;
      if (!body) return false;
      const hasNsClass = /\bns-\d+\b/.test(body.className);
      if (hasNsClass && !body.classList.contains('ns-0')) return false;
      const action = new URLSearchParams(location.search).get('action');
      return !action || action === 'view';
    },

    /** Insert the bar right above the first paragraph of the plot. */
    mount(bar, plotNodes, plotHeading) {
      for (const n of plotNodes) {
        const p = n.matches('p') ? n : n.querySelector('p');
        if (p && !p.closest(Tokenizer.SKIP)) {
          p.parentNode.insertBefore(bar, p);
          return;
        }
      }
      const block = Sections.blockFor(plotHeading);
      block.parentNode.insertBefore(bar, block.nextSibling);
    },

    async loadImages(characters) {
      const linked = characters.filter((c) => c.actorTitle);
      for (const c of characters) {
        if (!c.actorTitle) Avatars.set(c, { status: 'none' });
      }
      if (!linked.length) return;

      Toggle.setBusy(true);
      const urls = await Images.resolve(linked.map((c) => c.actorTitle));
      for (const c of linked) {
        const u = urls.get(c.actorTitle);
        Avatars.set(c, u ? { status: 'ok', url: u } : { status: 'none' });
      }
      Toggle.setBusy(false);
    },

    async init() {
      if (!this.eligible()) return;
      const root = Sections.contentRoot();
      if (!root) return;

      const plotH = Sections.findHeading(root, CONFIG.PLOT_IDS, CONFIG.PLOT_TEXT);
      const castH = Sections.findHeading(root, CONFIG.CAST_IDS, CONFIG.CAST_TEXT);
      if (!plotH || !castH) { log('No plot or cast section; staying hidden.'); return; }

      const roster = Cast.build(CastParser.parse(Sections.contentOf(castH)));
      if (!roster.length) { log('Cast section had no parseable actor/character pairs.'); return; }

      const aliases = Aliases.build(roster);
      const plotNodes = Sections.contentOf(plotH);
      const { count, used } = Tokenizer.run(plotNodes, aliases, (c, text, kind) => Entity.create(c, text, kind));
      if (!count) { log('No cast names found in the plot.'); return; }

      const mentioned = roster.filter((c) => used.has(c.id));
      const charsById = new Map(roster.map((c) => [c.id, c]));

      const bar = Toggle.build({
        characterCount: mentioned.length,
        mentionCount: count,
        onChange: (m) => this.setMode(m),
      });
      this.mount(bar, plotNodes, plotH);
      Tooltip.init(charsById);

      const saved = await Store.get(CONFIG.MODE_KEY);
      this.setMode(CONFIG.MODES.includes(saved) ? saved : CONFIG.DEFAULT_MODE, false);
      document.documentElement.dataset.wikifaceReady = 'true';
      log(`Linked ${mentioned.length} characters, ${count} mentions.`, roster);

      await this.loadImages(mentioned);
    },
  };

  // Test hook: lets a harness reach the modules without touching globals in production.
  if (window.__WIKIFACE_EXPOSE__) {
    window.__WikiFace = { CONFIG, Util, Sections, CastParser, Cast, Aliases, Tokenizer, Images, Avatars, Controller };
  }

  Controller.init().catch((err) => console.warn('[WikiFace] init failed:', err));
})();
