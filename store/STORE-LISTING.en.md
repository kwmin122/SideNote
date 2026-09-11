# Chrome Web Store listing (SideNote) — English

Copy each block **verbatim** into the matching field in the Developer Dashboard.
This is the listing for the **default (English)** locale. The Korean listing lives in `STORE-LISTING.md`;
the dashboard lets you add it as a second language on the same item.

---

## 1. Store listing tab

### Name (max 75 chars)
```
SideNote
```

### Short description (max 132 chars)
```
Turn any lecture tab's audio into live captions on your own machine, and keep notes and screenshots beside them in the side panel.
```

### Detailed description
```
SideNote is a study notebook for online lectures. Captions, notes, and screenshots all live in one panel next to the video.

■ Live captions
SideNote listens to the tab you are watching and turns it into captions. Start, pause, resume, and stop are all under your control.
Captions stack up and follow along automatically. Scroll up to reread something and the auto-follow stops; scroll back to the bottom
and it resumes. You can copy the whole transcript at once.

■ Captions over the video
Turn them on and the captions sit on top of the video, the way normal subtitles do.

■ Screenshots with the note you took at that moment
Press [Capture] and the current screen is saved. If a video is playing, SideNote crops the shot to the video area and records the
playback position (12:34, say). Every capture can carry its own note, so "what I thought about this slide" stays attached to the slide.
A general note for the whole lecture is saved automatically as you type.

■ One notebook per video
Move to a different video and captions restart on their own. Old captions never bleed into the new video, and the previous video's
captions, notes, and captures stay in [History] where you can reopen them any time.

■ Still there when you come back
Reload the page or close and reopen the side panel and everything is still there. Return to the same lecture page and SideNote
picks up that notebook again.

■ Nothing leaves your computer
Speech recognition runs through Chrome's built-in on-device recognizer, on your machine. Audio, captions, notes, and screenshots
are never uploaded. No account, no sign-in, no payment, no ads.

■ Translate the lecture as you watch
Watching an English lecture but want Korean captions? Open [Caption settings] and set the caption language to Korean.
What is being said is shown in that language, in the panel and on the video overlay. Pick the language that is being
spoken and captions stay exactly as spoken. Translation uses Chrome's built-in translator, which runs on this computer.
No API key, no per-use cost, no server. Chrome downloads the translation model for your language pair the first time
you use it, and support varies by device and language pair.

■ Choose your languages
The spoken language can be English, Korean, Japanese, Chinese, Spanish, French, German, Italian, Portuguese,
Russian, Hindi, Arabic, Indonesian, Vietnamese, Thai, Turkish, Dutch, Polish, or Swedish. The interface language is
yours to pick in the top right of the panel — English, Korean, Japanese, Simplified Chinese, or whatever your browser
uses. Chrome downloads the on-device speech pack for your chosen language the first time you use it.

■ Who it is for
· Anyone taking notes while watching lecture recordings or MOOCs
· Anyone who wants a text record of a lecture video that has no subtitles
· Anyone tired of screenshots in one folder and notes in another

■ How to use it
1) Play a lecture video.
2) Click the SideNote icon on that tab. The panel opens on the right.
3) Press [Start captions]. Allow tab audio sharing when Chrome asks.

■ Notes
· On the first run you may wait a moment while Chrome downloads the speech pack for your language.
· Captions come from automatic recognition, so they are not 100% accurate. Use them as a study aid.
· Captions cannot be made for silent tabs or chrome:// pages.
· Translation needs Chrome's built-in translator. If your Chrome or language pair does not support it, captions still
  work and only the translation is skipped.
· Chrome 139 or newer is required (on-device speech recognition arrived in that version).
```

### Category
```
Productivity  →  Workflow & Planning
```

### Language
```
English (add Korean as a second listing language using STORE-LISTING.md)
```

### Store icon (128x128)
```
brand/sidenote-icon-128.png  (apps/extension/public/icons/icon-128.png also works)
```

### Screenshots (1280x800 PNG, at least 1, 4–5 recommended)
Same four shots described in `STORE-LISTING.md`. Take them with Chrome set to English so the panel
text in the screenshots matches this listing.

---

## 2. Privacy practices tab

### Single purpose
```
SideNote's only purpose is to turn the audio of a lecture video playing in the current Chrome tab into captions on the user's own device, optionally translate those captions on-device, and collect them together with the user's notes and screen captures in one side panel as a study notebook.
```

### Permission justifications (paste into each field)

**tabCapture**
```
Required to receive audio from the tab where the user pressed [Start captions] and turn it into captions. This is the core feature of the extension. It applies only to the tab the user explicitly started, and is released the moment they stop. Captured audio is discarded right after recognition; it is never stored and never transmitted.
```

**offscreen**
```
A Manifest V3 service worker cannot use audio processing or the speech recognition API, so an offscreen document is needed to process the audio. The document exists only while captions are running and closes when they stop.
```

**sidePanel**
```
Used to show captions, notes, and screen captures next to the lecture video without covering it.
```

**storage**
```
Used to keep settings such as the spoken language, the caption language, the interface language, and the current session identifier on this computer. Nothing is synced or transmitted.
```

**activeTab**
```
This is the only way the extension reaches a page. Access is granted for the single tab where the user clicked the toolbar icon, and only from that click until the page navigates away. It is used to (1) identify the tab that captions and captures target, (2) read the position and playback time of the video playing in that tab, and (3) capture the screen at the moment the user asks for it. No broad host permissions (http://*/*, https://*/* or <all_urls>) are declared, and tabs the user has not clicked the icon on are never accessed.
```

**tabs**
```
When the tab being captioned closes or navigates elsewhere, recording and the offscreen document must be cleaned up. Tab events are subscribed to for that, and the lecture page title and URL are read to store alongside captures. Browsing history is never collected or transmitted.
```

**scripting**
```
Used only in the tab the user granted activeTab to by clicking the icon, to read the on-screen position and playback time of the <video> element, in order to (1) crop the screen capture to the video area, (2) record the playback position with the capture, and (3) draw the caption overlay on top of the video when the user turns it on. There are no automatically injected content scripts; injection happens only at the moment the user presses a button. Page content is never collected or transmitted.
```

> **No host_permissions are declared.** There is no field to paste them into, and the install screen shows no
> "read and change all your data on the websites you visit" warning. Page access relies solely on activeTab,
> granted for the tab where the user clicked the icon.

### Remote code
```
No. All code is contained in the package; no code is loaded from outside.
```

### Data usage disclosures (checkboxes)
| Item | Answer |
| --- | --- |
| Personally identifiable information | Not collected |
| Health information | Not collected |
| Financial and payment information | Not collected |
| Authentication information | Not collected |
| Personal communications | Not collected |
| Location | Not collected |
| Web history | Not collected |
| User activity | Not collected |
| Website content | Not collected |

Check **yes** on all three certification questions.

### Privacy policy URL
Publish `store/PRIVACY.en.md` at a public address and paste that URL.
A public GitHub Gist is the quickest option; a file URL in this public repository works too.

---

## 3. Distribution tab

- **Visibility**: submit as **Unlisted** first; switch to **Public** once real users report no problems.
- **Regions**: all regions (the UI is localized and the caption languages cover most of them).
- **Price**: free.
