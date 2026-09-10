# SideNote Privacy Policy

Last updated: 2026-09-10

SideNote ("the extension") is a Chrome extension that turns the audio of a lecture playing in a Chrome tab
into captions and stores them together with your notes and screen captures.

## In one line

**SideNote collects no data and sends nothing anywhere.** The captions, notes, and captures it creates are
stored only on your own computer. There is no account, no sign-in, no payment, and no advertising.

## What the extension handles

| Data | Where it comes from | Where it is stored | Sent anywhere? |
| --- | --- | --- | --- |
| Tab audio | The current tab when you press [Start captions] | Not stored (discarded right after recognition) | No |
| Caption text | Speech recognition of that audio | Browser local storage (IndexedDB) | No |
| Notes | Typed by you | Browser local storage (IndexedDB) | No |
| Screen captures | The current tab's screen when you press [Capture] | Browser local storage (IndexedDB) | No |
| Page title, URL, playback position | The current tab | Stored locally as metadata on captures and captions | No |
| Settings (caption language, etc.) | Your choice | `chrome.storage.local` | No |

## Where speech recognition happens

The extension uses **only Chrome's built-in on-device speech recognition**, which runs on your own computer.
It requests recognition with `processLocally: true` only, so it never uses a recognition path that sends audio
over the network. Chrome downloads the speech language pack from Google; that is Chrome's own behavior, and the
extension sends no audio or captions as part of it.

The extension does not talk to any external program or server. It makes no outbound network requests of its own.

## What the extension does not do

- Collect personal information (name, email, address, identity data)
- Collect health or financial information
- Collect authentication data (passwords, cookies, tokens)
- Collect location data
- Collect browsing history (a list of sites you visit)
- Track user activity or embed analytics
- Sell, transfer, or share data with third parties
- Use data for anything unrelated to the extension's core feature

## Why each permission is requested

- `tabCapture` — to receive the sound of the current tab and turn it into captions. Applies only to the tab where you pressed [Start captions].
- `offscreen` — to open a document that can process audio under Manifest V3. Audio is processed only inside that document and is not stored.
- `sidePanel` — to display captions, notes, and captures in the right-hand panel.
- `storage` — to keep your settings and session list on this computer.
- `activeTab`, `tabs` — to identify the tab being captioned and captured, and to clean up recording when that tab closes or navigates away.
- `scripting` — to read the on-screen position and playback time of the playing `<video>`, so captures can be cropped to the video area and captions can be overlaid on the video when you turn that on.
- `host_permissions` (`http://*/*`, `https://*/*`) — because lectures can be on any site, and both of the above must work wherever you are watching. Page content is never read, stored, or transmitted.

## Deleting your data

Delete individual notebooks from the [History] list in the panel, or clear just the current notebook's captions
with [Clear current captions]. Removing the extension from Chrome deletes all stored captions, notes, and captures
along with it. No copy remains on any server.

## Contact

bill.min122@gmail.com
