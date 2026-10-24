import type { Config } from '../../lib/config.js'

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The public privacy policy, which Meta requires at a public address. It says what Instagram data is read and why, what is not,
 * where it goes, how long it is kept and how to remove it. The wording is a starting point for a lawyer, who should add the legal
 * entity's address; the entity's name and a contact come from LEGAL_ENTITY_NAME and PRIVACY_CONTACT_EMAIL.
 */
export function privacyPage(
  config: Pick<Config, 'LEGAL_ENTITY_NAME' | 'PRIVACY_CONTACT_EMAIL'>,
): string {
  const who = esc(config.LEGAL_ENTITY_NAME)
  const contact = config.PRIVACY_CONTACT_EMAIL
    ? `<a href="mailto:${esc(config.PRIVACY_CONTACT_EMAIL)}">${esc(config.PRIVACY_CONTACT_EMAIL)}</a>`
    : '<strong>[set PRIVACY_CONTACT_EMAIL]</strong>'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy policy: ${who}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1b2230}h1,h2{line-height:1.25}li{margin:.25rem 0}</style></head>
<body>
<h1>Privacy policy</h1>
<p>${who} makes Lypcut, a video editor you talk to. This page explains what we do with your Instagram data if you choose to connect your account. If you do not connect it, none of this applies.</p>

<h2>What we read, and only after you approve</h2>
<ul>
<li>Your Instagram handle, to show which account is connected.</li>
<li>The list of your own Reels: when each was posted.</li>
<li>Each Reel's numbers: views, reach, likes, comments, saves, shares, average watch time and how many people left in the first seconds.</li>
</ul>
<p>We ask for read-only permission (<code>instagram_business_basic</code> and <code>instagram_business_manage_insights</code>). We never post, comment, message or change anything on your account.</p>

<h2>What we do not read or keep</h2>
<ul>
<li>Your password, your messages, your followers, or the comments on your Reels or who wrote them.</li>
<li>The captions of your Reels, other people's content, or your videos: we do not download them.</li>
</ul>

<h2>Why</h2>
<p>To work out which of your Reels did best and describe your editing style as numbers: how soon you start, how often you cut, which caption look you use. The assistant in Lypcut then edits your videos the way you do. Nothing is posted anywhere.</p>

<h2>Where it goes</h2>
<p>Your access token is stored encrypted. Our language-model provider receives only a short list of figures about your style (for example, how often you cut) to write one sentence, never your handle, your token or your Reels' numbers. We do not sell your data or share it for advertising.</p>

<h2>How long we keep it</h2>
<p>Until you disconnect or delete your account. Disconnecting on the Style page removes your connection, your Reels, their numbers and your style within 24 hours. If you remove Lypcut in Instagram's settings, Instagram tells us, and we delete the Instagram data the same way.</p>

<h2>Your choices</h2>
<ul>
<li>Disconnect at any time on the Style page, or delete your whole account.</li>
<li>Remove Lypcut in Instagram under Settings, Apps and websites.</li>
<li>Ask us about your data: ${contact}.</li>
</ul>

<p><small>${who}</small></p>
</body></html>`
}
