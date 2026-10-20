# WikiFace 🎭

🎭 Chrome extension that lets you read Wikipedia plot summaries with actor names or faces instead of character names. One click: Characters ↔ Actors ↔ Faces.

**Read Wikipedia plot summaries with the faces you actually remember.**

WikiFace is a lightweight Chrome extension that adds a small toggle above the Plot section of film and TV articles on Wikipedia. One click swaps character names for the actors who play them, or for their faces.

```
[ 👤 Characters | 🎭 Actors | 🖼️ Faces ]
```

| Mode | What you read |
|---|---|
| 👤 **Characters** (default) | The original text: *"Deckard meets Rachael at the Tyrell Corporation…"* |
| 🎭 **Actors** | *"Harrison Ford meets Sean Young at the Tyrell Corporation…"* |
| 🖼️ **Faces** | A small round headshot next to each name, tinted per character |

Hover any name to see a card with the actor's photo and name, and "as *Character*".

---

## The problem it solves

You've watched a film, or you're halfway through a series, and you open the Wikipedia plot to remember what happened. Within two paragraphs you're lost: *who was Marcus again? Is Elena the sister or the detective?*

Most viewers remember **faces and actors**, not character names. Plot summaries are written only in character names, so readers keep scrolling down to the Cast list and back up again to work out who's who.

WikiFace puts that mapping into the text itself, so you can follow the story in whichever form your memory works best.

This helps most with:
- Ensemble casts and long-running TV series
- Films you saw a while ago
- Foreign-language films, where character names are unfamiliar
- Deciding whether to watch something by seeing who plays which part

---

## How it works

Everything runs locally in your browser on Wikipedia pages. There are no accounts, no tracking, and no third-party servers.

1. **Finds the sections.** It locates the Plot (or Synopsis or Premise) section and the Cast section. It works with Wikipedia's current design, the older desktop design, and the mobile site.
2. **Reads the cast list.** It understands common Wikipedia formats:
   - *Actor as Character*
   - *Character, played by Actor*
   - *Actor – Character*
   - *Character (Actor)*
   - Cast tables
3. **Matches names carefully.** It matches full names first, then surnames, titles ("Dr. Tyrell") and nicknames ("Doc Brown"). It avoids false matches:
   - "In **May**" is left alone, but "**May** Parker" is matched.
   - "**Will**" is matched only when it's clearly a name.
   - A surname shared by two characters is skipped, so the right person is never guessed wrong.
4. **Never breaks the page.** Only the plain text is touched. Links, `[1]` citation markers and formatting stay exactly as they were.
5. **Fetches photos efficiently.** It uses Wikipedia's own image API in a single batched request. Results are cached for a week, and actors without a photo get a neat initials badge.

---

## Install (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select the `wikiface/` folder.
4. Open a film article and look for the toggle above the plot. Good first tests:
   - [Blade Runner](https://en.wikipedia.org/wiki/Blade_Runner)
   - [Back to the Future](https://en.wikipedia.org/wiki/Back_to_the_Future)
   - [The Shawshank Redemption](https://en.wikipedia.org/wiki/The_Shawshank_Redemption)

Your last chosen mode is remembered across articles. If an article has no Cast section, the toggle doesn't appear.

---

## Project structure

```
wikiface/
├── manifest.json   # Manifest V3 config, scoped to *.wikipedia.org/wiki/*
├── content.js      # Section finding, cast parsing, name matching, image fetching, UI
├── content.css     # Toggle, avatar chips, hover card, light/dark themes
└── icons/          # icon.svg source + 16/32/48/128 px PNGs
```

**Permissions:**
- `storage` caches actor photos and remembers your chosen mode.
- Host access to `*.wikipedia.org/w/api.php` is used to fetch thumbnails.
- `activeTab` is included but not currently used.

---

## Pending enhancements

Contributions are welcome. These are the known gaps and planned improvements:

**Accuracy**
- [ ] **Live testing across many real articles.** Development so far used realistic copies of Wikipedia's page structure. Broad testing on live pages is the top priority.
- [ ] **Names split by formatting.** For example `<a>David</a> Smith` is currently matched as two words rather than one full name.
- [ ] **Prose-style cast sections.** Casts written as paragraphs instead of lists or tables aren't read yet.
- [ ] **Wikidata as a fallback.** Use Wikidata's cast-member data when an article's Cast section is missing or hard to parse.
- [ ] **Episode and season articles.** Pick up recurring cast from the parent series page.

**Reach**
- [ ] **Other Wikipedia languages.** Recognise translated section names, e.g. *Handlung / Besetzung*, *Intrigue / Distribution*, *कथानक / कलाकार*.
- [ ] **Firefox and Edge.** Package for both browsers. Edge should work as-is; Firefox needs small manifest changes.
- [ ] **Chrome Web Store.** Publish a listing.

**Experience**
- [ ] **Toolbar popup.** Set the default mode, switch the extension off per site, and clear the photo cache.
- [ ] **Hover cards.** Better coexistence with Wikipedia's built-in link previews.
- [ ] **"Both" mode.** Show *Harrison Ford (Deckard)* inline.
- [ ] **Beyond the plot.** Optionally apply the same switching to Episode lists and Reception sections.

**Housekeeping**
- [ ] **Clean up permissions.** Remove the unused `activeTab` permission.
- [ ] **Automated tests.** Add an automated test suite with saved Wikipedia page snapshots.

---

## Credits

💡 **Original idea by [Kamal Gaur](IDEA_URL_HERE).** Thank you for spotting a small, everyday frustration that millions of readers share, and imagining a simple fix for it.

Actor photos and article data come from [Wikipedia](https://www.wikipedia.org/) via the MediaWiki API. Images remain subject to their original licences on Wikimedia Commons.

WikiFace is an independent project and is not affiliated with or endorsed by the Wikimedia Foundation.

## License

MIT
