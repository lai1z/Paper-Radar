# Zotero batch import

## Recommended: retrieve metadata and PDFs with Zotero

Open **待读**, choose the range, and click **复制 arXiv ID（获取 PDF）**. In Zotero desktop, select the destination collection, click the toolbar magic wand (**Add Item by Identifier / 通过标识符添加条目**), paste, and press Enter. Do **not** use File → Import from Clipboard for this ID list. The default range is the current Pending/Read tab and search results; other options cover all pending papers or the whole list.

Zotero supports multiple arXiv IDs separated by newlines. Its native lookup uses the official arXiv translator, which obtains source metadata and supplies a `Preprint PDF` attachment. Zotero downloads that attachment, rather than Paper Radar merely adding a PDF link to CSL JSON. This also retrieves publication dates and abstracts missing from older local records. Canonical IDs are validated, deduplicated across versions, and prefixed `arXiv:`; lookup retrieves the current arXiv version. No Zotero API key, browser file download or custom translator is required.

Keep Zotero online and allow it to attach associated PDFs in General settings. Expand the new item and open its PDF to verify completion. Paper Radar only confirms copying; it cannot observe Zotero's import or attachment download. Network failures, unavailable PDFs or attachment settings can prevent completion. As an alternative, open the paper's arXiv abstract page and save it with Zotero Connector. Already imported metadata-only items are not automatically updated by identifier lookup; another import can create duplicates. Inspect Zotero Duplicate Items before merging.

Clipboard denial exposes a selected read-only ID list with instructions for the magic wand. Empty selections clear the fallback and warn that the clipboard was not updated. The operation does not change reading status, delete records, or create Better Notes notes.

## Optional: metadata-only CSL JSON

Expand **仅导出文献信息（不含 PDF）**, then use **下载 CSL JSON** or **复制文献信息**. These retain the original metadata-only export for offline use; neither includes PDF attachments.

In Zotero desktop, choose **File → Import → A file** and open the downloaded `paper-radar-zotero-*.csl.json`. CSL JSON is a native Zotero import format; Better Notes is not required for import. Imported bibliography items can be used in your usual Zotero/Better Notes workflow. This does not create Better Notes notes, transfer PDFs, sync the Zotero library, or change reading status.

For metadata-only copying, use **复制文献信息**, then **File → Import from Clipboard** in Zotero (Windows/Linux: Ctrl+Shift+Alt+I; macOS: Cmd+Shift+Option+I). This transfers CSL JSON without a browser file download. If clipboard permission is denied, a read-only text area appears with format-specific instructions. This does not diagnose or repair the operating system's download scanner.

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

Automated tests additionally verify sanitized/deduplicated batch IDs (including legacy IDs), all three selection scopes and search, identifier clipboard fallback, distinct import instructions, and that the metadata-only options are collapsed by default.

Manual acceptance: copy a small batch of known accessible IDs (e.g. `arXiv:1810.04805` and `arXiv:1706.03762`) to Zotero's magic wand. Check the fetched metadata and open the downloaded child PDFs. Repeat with automatic attachments disabled or the network unavailable and verify the site never reports download success. Import a CSL file separately to check its metadata-only behavior and duplicate handling. The automated tests do not launch Zotero, download its attachments, or test Better Notes.

References:
- https://www.zotero.org/support/adding_items_to_zotero#add_item_by_identifier
- https://github.com/zotero/zotero/blob/master/chrome/content/zotero/lookup.js (`saveAttachments: !childItem`)
- https://github.com/zotero/translators/blob/master/arXiv.org.js (`doSearch`, `Preprint PDF` attachment)
- https://www.zotero.org/support/kb/import_from_clipboard
- https://github.com/zotero/translators/blob/master/CSL%20JSON.js
