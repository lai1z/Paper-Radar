# Zotero batch import

Open **待读**, choose the export range, and click **导出到 Zotero**. The default exports the current Pending/Read tab and search results. Other options export all pending papers or the whole reading list.

In Zotero desktop, choose **File → Import → A file** and open the downloaded `paper-radar-zotero-*.csl.json`. CSL JSON is a native Zotero import format; Better Notes is not required for import. Imported bibliography items can be used in your usual Zotero/Better Notes workflow. This does not create Better Notes notes, transfer PDFs, sync the Zotero library, or change reading status.

If downloading fails (for example, the browser reports a virus scan failure), use **复制到 Zotero**, then **File → Import from Clipboard** in Zotero (Windows/Linux: Ctrl+Shift+Alt+I; macOS: Cmd+Shift+Option+I). This transfers the same CSL JSON without downloading a file or changing security settings. If clipboard permission is denied, a read-only text area appears for manual selection and copying. An empty selection leaves the clipboard unchanged and warns against importing stale clipboard data. This alternative does not diagnose or repair the operating system's download scanner.

The existing **导出备份 / 导入备份** buttons still use the version-1 Paper Radar JSON format, preserving status and saved time. CSL JSON is a bibliography exchange format, not a replacement for that backup.

## Metadata contract

| Source | CSL JSON | Policy |
| --- | --- | --- |
| `title` | `title` | Preserve Unicode; absent title uses `arXiv: ID` and is counted in the warning. |
| `authorNames` array, otherwise `authors` | `author` | One creator per array entry; structured family/given fields preserved. Unstructured full names use CSL `literal`, avoiding guessed Chinese or compound surname splits. |
| `id` or arXiv `url` | `id`, `URL`, `archive`, `archive_location`, `note` | Canonical versionless arXiv ID; no invented DOI. `type: article` is a CSL generic article, not a claim of journal publication. |
| `published`, then `publicationDate` | `issued.date-parts` | ISO year/month/day or ISO timestamp; invalid/missing publication date omitted. Never use `date` (crawl date), save time or ID month as publication date. |
| `abstract`, then `details` | `abstract` | Full original abstract, not the card's truncated text or AI TL;DR. |

The feed adapter now retains raw authors, original abstract, and any explicit publication date. Existing local backups remain readable. Older saved records did not retain original abstracts or publication dates; these cannot be recovered from their AI summaries or crawl dates. Exports report missing metadata and leave those fields empty. There are no metadata network requests. The current crawler may not supply `published`; exporting an exact publication date requires that source field to be supplied upstream. The change does not rerun the crawler.

Legacy author strings are split on commas/semicolons/newlines (the former app used comma separation). A comma-separated string alone cannot distinguish `Smith, John` from two people. New array-valued authors retain their boundaries, including internal commas. For exact legacy names, supply `authorNames` as an array in a backup before importing it into an empty list.

Duplicate IDs and versioned URLs are merged within each export. Missing metadata is filled from another occurrence; first nonempty values win. Different IDs with the same title remain separate. Re-importing a file into Zotero can still create duplicates: exports cannot inspect an existing Zotero library, and stable CSL IDs do not guarantee an upsert. Review Zotero's Duplicate Items before merging. Export does not modify the reading list.

## Tests

From the repository root (Node.js 18+):

```sh
node --test tests/zotero-export.test.cjs
node --check js/zotero-export.js
node --check js/reading-list.js
node --check js/app.js
```

Optional browser integration test:

```sh
npm install --no-save playwright
npx playwright install chromium
node tests/zotero-export.browser.cjs
```

For an installed Edge or Chrome, set `BROWSER_CHANNEL=msedge` or `chrome`. Browser tests use local fixtures and intercept all requests; no API credentials are needed. They verify actual downloaded files and JSON backup restoration. Unit tests cover ID versions, duplicates, Chinese/diacritics, missing/invalid fields, leap dates, unstructured and structured names, input immutability, and the real feed parser.

Manual acceptance: import an exported file in Zotero, check title, separate creators, abstract, publication date and the arXiv URL/Extra field. Import it again and verify duplicate handling in Zotero. The automated tests do not launch Zotero or test Better Notes.

References: https://www.zotero.org/support/kb/import_from_clipboard and https://github.com/zotero/translators/blob/master/CSL%20JSON.js
