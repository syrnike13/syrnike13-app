# Mobile layout reference

Layout and behaviour of the Android app follow the Discord mobile app (observed
2026-10-31 on a Pixel 9, 420 dpi, values in dp). Only the layout, screen flow
and metrics are copied; every surface is built from our `ui-native` primitives,
Prism tokens and icon registry, never from Discord's colours or assets.

## Shell

There is no bottom tab bar.

- **Server rail**, always visible on the left, 72 wide.
  - Item slot 60 tall with a 48 icon.
  - Top: the Direct Messages button. It is a rounded square, `primary` when selected. A divider sits below it.
  - Then servers. A selected or unread server has a pill on the left edge (white bar, 40 tall when selected, a dot when unread).
  - Mention badges sit bottom-right of the icon: red, white text.
  - Folders are a rounded column background holding their servers.
  - The last item is "Add server".
  - While in a call, the server icon gets a green speaker badge top-right.
- **Main panel** fills the rest. Its top-left corner is rounded about 16; the panel surface is lighter than the rail background.
- **User bar** floats over the bottom of the panel: a card inset 16 from the screen edges, 58 tall, rounded about 16.
  - Avatar 48 with a status badge.
  - Name 16/medium with a chevron; below it the status line 13 ("Do not disturb" or, in a call, "In voice chat" with a green speaker).
  - A bell button on the right opens Notifications.
  - Tapping the name or avatar opens the profile ("You").

## Direct messages home (rail: DM button)

- Title "Direct Messages" 24/bold at x 89, y 83.
- Action row, 32 tall, 10–12 apart:
  - square search button;
  - wide "Add friends" button with icon and label;
  - square `primary` "New message" button.
- **Happening now**: a horizontal carousel of cards, 264×88, rounded about 16. Each card shows active voice channels or calls: stacked avatars, "+N", names, "🔊 • channel".
- **DM rows**, 50 tall, inset 8, rounded about 12 when pressed or selected (selected row tinted).
  - Avatar 40 with a status badge; group DMs show two overlapping avatars.
  - Name 16 starting at x 133; a preview line 14 muted below it ("You: …", "Missed call", an activity).
  - Relative time 12 muted on the right ("17 d", "1 mo").

## Server channel list (rail: a server)

- Header:
  - server name 22/bold with a chevron, opening server info;
  - optionally a "N members • Community" line 14 muted;
  - action row 32 tall: a wide search field-button, then square "Invite" and "Events" buttons.
- Divider, optional "Server boosts" row, divider.
- **Pinned channels** section title 15/medium muted.
- **Category headers**, 27 tall:
  - title 15/medium, sentence case (not uppercase), followed by a chevron;
  - tap collapses; collapsed categories still list unread channels.
- **Channel rows**, 36 tall, inset 8 (row 322 wide), rounded about 8.
  - Icon 20 at x 89, name 16 at x 115.
  - Read channels are muted; unread channels use the foreground colour plus a pill dot on the panel edge.
  - The selected channel has a lighter background.
  - Right side: mention count or, for forums, a counter.
- **Voice channel rows**: speaker icon. While someone is in the channel:
  - participants are listed under it, indented to x 115, with 24 avatars and names 14;
  - the row shows the call timer on the right (green, monospace);
  - the icon turns green for the user's own channel.

## Chat (text channel or DM)

- **Header**, 56 tall:
  - back button 40, carrying the red total-unread badge bottom-right;
  - title 18/semibold with a chevron (`# channel` or, for DMs, avatar 32 with status and the name), opening details;
  - a subtitle 12 muted with a green dot ("13 online");
  - buttons 32 on the right: search; DMs also have voice call and video call.
- **Channel start**:
  - large icon 64 in a circle;
  - "Welcome to …" 28/bold;
  - description 16 muted;
  - onboarding cards 58 tall, rounded about 12.
- **Message rows**:
  - avatar 40 at x 12;
  - text column from x 64 to 12 from the right edge;
  - author 16/medium followed by a timestamp 12 muted;
  - body 16 with a 22 line;
  - "(edited)" 12 muted inline;
  - grouped follow-ups drop the avatar and author.
- **Reactions**: chips 30 tall, emoji 20 + count 14. Chips you reacted with have a `primary` outline. A trailing add-reaction chip.
- **Date divider**: a centred label 14/medium between two lines.
- **Embeds**: a rounded card about 12 with a 4 accent bar on the left; site name in `primary`, then the title.
- **Call events** in DMs: a full-width card 52 tall, rounded about 12. It holds a phone icon, "Call ended" 16/semibold, "duration — date" 14 muted, and the participant avatar 24 on the right.
- **Composer**: a pill floating 16 from the screen edges, 58 tall, fully rounded.
  - Left: "+" (attachments) 32.
  - Then the input with placeholder "Message #channel" / "Message @user".
  - Right: gift 32, emoji 32, microphone (voice message) 32.
  - Icons are 20.

## Voice channel

1. **Preview sheet.** Tapping a voice channel opens a bottom sheet over the channel list; it does not join yet.
   - Top row: collapse 32, the channel name pill with a chevron, and "Invite" 32 on the right.
   - Middle: participants, or an empty state ("Nobody here yet").
   - Bottom card, inset 16, rounded about 20:
     - a microphone toggle 48, muted and red before joining;
     - a large green "Join voice channel" button;
     - a chat button.
2. **Call stage** (after joining; full screen):
   - Top bar:
     - collapse 32 (minimises);
     - the channel name pill with a chevron;
     - on the right, the speaker/output toggle (filled white when on), "Invite" and "Chat", all 32 and 12 apart.
   - Tiles: rounded about 12, inset 12 from the screen edges. A single participant gets a square full-width tile. A tile without video uses a background tinted from the avatar, the avatar about 80 in the centre, and a name pill at the bottom centre.
   - An "Add people to voice chat" card, 64 tall, rounded about 16, above the controls.
   - Controls dock, inset 16 from the edges, 78 tall, rounded about 20, with a grab handle on top.
     - Five evenly spaced buttons: camera, microphone, screen share, effects/soundboard, and leave.
     - Icons are 24 and have no background, except "Leave": a red rounded square 48 with a phone-down icon.
     - Toggles show their off state with a slashed icon.
3. **Auto-hide.**
   - Behaviour:
     - The top bar and the dock hide about 3 s after they were last shown (measured 2.5–3.1 s).
     - The top bar slides up and the dock slides down, both fading out.
     - Tapping empty stage space or a tile toggles them.
     - With several participants, a tile tap focuses that participant (not verified: the channel was empty).
   - The "Add people" card hides together with the controls.
4. **Minimised call.** The collapse button returns to the app. The call keeps going as a floating square about 120, rounded about 16, top-right over every screen. It shows the active speaker or video, has no controls, and opens the stage when tapped.

## Notifications (bell on the user bar)

- Header 56: back with the unread badge, title 22/bold, then buttons on the right (saved, history, more).
- "Recent activity" section title 15 muted.
- Rows:
  - avatar 48;
  - "Author **mentions you in** Server — #channel:" 16;
  - the quoted message with a 4 bar on its left;
  - the relative time on the right.

## Profile ("You", from the user bar)

- A full-screen sheet with a close button on the banner, a large avatar 96 with status, and a custom status bubble.
- Display name 28/bold with a chevron; username • pronouns line with badges.
- "Edit profile" in a full-width `primary` button.
- Underline tabs: Main / Activity / Wishlist.
- Cards rounded about 16.
  - When in a call: "In voice chat" with the channel and server, an "Open voice chat" button, and voice settings (mute).
- A floating bottom pill navigation: Quests, Shop, Nitro, Settings. Of these we keep only Settings.
