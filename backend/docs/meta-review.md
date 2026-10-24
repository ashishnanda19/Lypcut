# Meta app review: the checklist

Everything you need to do to let people other than you connect Instagram to Lypcut. Written 25 October 2026 from Meta's current documentation; Meta changes these
pages, so where this says **verify**, open the linked page or the App Dashboard and check before you submit.

**The short version.** You need a public HTTPS domain, a privacy policy page, a verified business, a working connect flow to record, and then one review submission for two read-only
permissions. Review takes weeks. Until it passes, only people with a role on the app can connect; everyone else uses the manual upload path, which works today.

## 0. What you need before you start

| Item                                                                                                                                           | Why                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Facebook account that will own the Meta developer account                                                                                    | Meta developer accounts are created from a Facebook login                                                                                           |
| A Meta Business portfolio for your legal entity                                                                                                | Business Verification is done on it                                                                                                                 |
| Legal entity documents (registration certificate, a utility bill or bank statement in the entity's name, a domain you own with an email on it) | Business Verification asks for them. **Verify** the exact list in Business Settings, Security Center                                                |
| A public HTTPS domain (for example `app.lypcut.com` for the app and `api.lypcut.com`)                                                          | Redirect, privacy policy and deletion callback URLs must be HTTPS and reachable by Meta                                                             |
| A business email that is read                                                                                                                  | Meta sends review results there                                                                                                                     |
| A 1024 × 1024 app icon                                                                                                                         | Required by app settings ([App Review](https://developers.facebook.com/documentation/instagram-platform/app-review.md))                             |
| Two Instagram accounts set to **Creator** or **Business**                                                                                      | One for you, one for testers; the review needs a working account. Free: Instagram, Settings, Account type and tools, Switch to professional account |

## 1. Create the Meta developer app

1. Go to https://developers.facebook.com, log in, and register as a developer if asked.
2. Create an app and choose the **Business** type (an app that is not Business type will not offer the Instagram product; Meta's [Get started](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started.md) says to create a new Business app if yours is not).
3. Add the **Instagram** product. In the dashboard open **Instagram, API setup with Instagram business login**. This is the "Instagram Login" path; do not choose the Facebook Login path. An app can use only one.
4. Copy the **Instagram app ID** and **Instagram app secret** shown there (not the Meta app ID). These become `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` in `backend/.env`. Never commit them.
5. Under the business login settings, add the **redirect URL**: `https://<api-domain>/api/style/callback`. It must match `INSTAGRAM_REDIRECT_URI` exactly. Lypcut never takes the redirect from the request.

## 2. App settings Meta checks

| Setting                           | Value                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App name                          | Lypcut                                                                                                                                                          |
| App icon                          | the 1024 × 1024 icon                                                                                                                                            |
| Privacy Policy URL                | `https://<app-domain>/privacy` (or `https://<api-domain>/api/privacy`, which the backend already serves; content outline in section 5)                          |
| Data deletion                     | Callback URL `https://<api-domain>/api/privacy/instagram/deletion` (built). **Verify** where this field sits: Instagram product settings or App settings, Basic |
| Category                          | Photo & Video Editing, or the closest Meta offers                                                                                                               |
| Business email                    | the monitored address                                                                                                                                           |
| Business use / Business portfolio | the verified entity                                                                                                                                             |

## 3. The permissions to request, and why

Request exactly these two. Do not request any permission that publishes, comments or messages: Meta rejects permissions the app does not use, and Lypcut is read-only by design.

| Permission                           | One-line justification for the form                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `instagram_business_basic`           | "Lypcut shows the creator the handle of the Instagram account they connected, reads the list of their own Reels, and refreshes the access token so the connection keeps working."                                                                                  |
| `instagram_business_manage_insights` | "Lypcut reads the creator's own per-Reel numbers (views, likes, comments, saves, shares, average watch time) to find which of their Reels performed best, so the editing assistant can match the style of their winners. Nothing is posted and nothing is shared." |

The "manage" in the second name is Meta's wording for insights access. Lypcut calls only the `GET` insights endpoint ([Media insights](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights.md)).

## 4. Business Verification

Business Verification is the slow part, and review needs it for Advanced Access (you told me it does; I could not find it on the pages I could read, so **verify** in the dashboard under Advanced Access).

1. Meta Business Suite, Settings, Security Center, **Start verification**.
2. Enter the legal name, address, phone and website exactly as on your documents.
3. Upload the documents from section 0. The name and address on every document must match.
4. Verify the domain (a DNS TXT record or a meta tag on the app domain) and the email on it.
5. Wait. It can take days to weeks; start it today. Nothing else on this list is blocked by it except the final submission.

## 5. The privacy policy

Meta checks that the policy exists at a public URL and describes the data you use ([Privacy Policy Expectations](https://developers.facebook.com/documentation/development/terms-and-policies/privacy-policy)). Lypcut serves it at `/api/privacy`; the text below is the outline it follows, and your lawyer should approve the final wording and add the legal entity, address and contact.

- Who we are, and how to contact us (name, address, email).
- What we read from Instagram, and only after you click Connect and approve: your handle, the list of your own Reels (ids, dates, durations where available), and each Reel's numbers (views, likes, comments, saves, shares, average watch time, skip rate).
- What we do not read or keep: your password, your messages, your followers, comments or the people who engaged, captions, other people's content. We never post, comment or message.
- Why: to learn which Reels worked best and describe your style as numbers (how quickly you start, how often you cut, which caption look you use).
- Where it goes: stored encrypted at rest; our language-model provider receives only a short list of numbers to write one sentence, never your handle, your token or your numbers over time. (The final text states the provider by name.)
- How long: until you disconnect or delete your account. Disconnect removes the token, the Reels, the analysis and your style profile within 24 hours.
- Your choices: disconnect any time on the Style page; delete your account; or remove Lypcut in Instagram's settings, Apps and websites, which triggers Meta's deletion request to us.
- That we do not sell data, and that we use it only for your own style.

## 6. Data deletion callback

Meta asks apps to provide a way for people to ask for their data to be deleted, either a callback or instructions ([Facebook Login overview](https://developers.facebook.com/documentation/facebook-login/overview)). Lypcut builds a callback.

- URL: `https://<api-domain>/api/privacy/instagram/deletion` (POST from Meta; GET for the status page).
- What it receives: a form-encoded `signed_request`. It verifies the HMAC-SHA256 signature with the app secret (constant-time compare), deletes that person's Instagram-derived data, and answers `{ "url": "<status page>", "confirmation_code": "<code>" }`. **Verify** this format against Meta's current "Data Deletion Request Callback" page; my tools could not open it.
- Test it from the dashboard: **Instagram, API setup, Webhooks** or the app's callback tester, and by removing the app from a test account's Apps and websites.

## 7. Test users while review is pending

Before approval, only people with a role on the app can connect, and only Standard Access applies: it is for businesses you own or manage ([App Review](https://developers.facebook.com/documentation/instagram-platform/app-review.md)).

1. App Dashboard, **App roles, Roles**: add yourself and teammates as Administrators or Developers, and testers as **Instagram Testers**.
2. Each tester accepts the invite in Instagram: Settings, Apps and websites, Tester invites. **Verify** the current path.
3. Their Instagram account must be Creator or Business.
4. Have two testers ready for the review: one with Reels that have a few thousand views, to show the numbers.

Customers (everyone else) need **Advanced Access**, which only App Review grants. Until then they use manual upload.

## 8. Screen recording script

Meta wants an end-to-end screencast per permission, in English where possible, with captions or callouts, showing how the app uses it. Record one video that covers both, at 1080p, with the browser URL bar visible, and add on-screen captions. Use a Creator test account that has Reels.

**Permission: `instagram_business_basic`**

1. Open Lypcut, sign in. Caption: "A Lypcut creator signs in."
2. Open the **Style** page. Show the connect screen with the plain-language list of what is read and what is never done.
3. Click **Connect Instagram**. Caption: "Lypcut asks Instagram for read-only access."
4. On Instagram's screen, show the permissions Instagram lists. Approve.
5. Back on Lypcut, show the connected handle. Caption: "Lypcut shows the connected account's handle and lists its Reels."
6. Show the list of Reels (thumbnails, dates, durations).

**Permission: `instagram_business_manage_insights`**

7. Show the per-Reel numbers on the Style page (views, likes, saves, shares, watch time). Caption: "Lypcut reads each Reel's own numbers."
8. Show the style profile that results, with the one-line summary. Caption: "From the best Reels, Lypcut describes the creator's style as numbers."
9. Open an editing project, ask the assistant to "match my style", and apply the result. Caption: "The creator's own winners decide the captions and pace Lypcut suggests."

**Show the controls (Meta looks for these)**

10. Click **Disconnect**. Show the profile and Reels disappear. Caption: "The creator can disconnect and delete everything at any time."
11. Show the privacy policy page, and the data-deletion URL answering a test request.

## 9. Reviewer instructions (paste into the submission)

> Lypcut is a web video editor. To test: open https://<app-domain>, sign in with the test account below, open **Style** in the left menu, and click **Connect Instagram**. Log in with the Instagram test account below (a Creator account) and approve. You will be returned to the Style page, which shows the connected handle and, after about a minute, the creator's Reels and a style profile. To disconnect, click **Disconnect** on the same page; the data is removed. Lypcut only reads: it never posts, comments or messages. Use of each permission is described in the fields above.
>
> Lypcut test account: `<email>` / `<password>`. Instagram test account: `<handle>` / `<password>`. (Create dedicated accounts for this; never use real ones.)

Meta also expects at least one successful API call per permission before you request Advanced Access: connect the test account once through the real flow (the connect flow is built) and the calls are on record.

## 10. What you can do today, and what waits

| Task                                                                              | Can start now?           | Waits for                                                                        |
| --------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Create the Meta developer account and the Business app, add the Instagram product | Yes                      |                                                                                  |
| Start Business Verification                                                       | **Yes, start today**     | Your legal documents; it runs for days to weeks                                  |
| Choose and buy the public domain; verify it in Business Settings                  | Yes                      |                                                                                  |
| Add yourself and testers; switch your Instagram accounts to Creator               | Yes                      |                                                                                  |
| App icon, category, business email                                                | Yes                      |                                                                                  |
| Privacy policy page                                                               | Draft now from section 5 | The backend serves it at `/api/privacy`; it needs the public API domain          |
| Data-deletion callback URL                                                        | Built                    | Needs the public API domain                                                      |
| Redirect URI in the dashboard                                                     | Reserve the value now    | The public API domain                                                            |
| Screencast                                                                        | No                       | Steps 6 and 7 (the real connect flow, running on the public domain)              |
| Submit for Advanced Access                                                        | No                       | Business Verification, the domain, the policy page, the callback, the screencast |

**Realistic order:** this week, create the app, buy the domain and start Business Verification. When Steps 6 and 7 are done and Lypcut is deployed on the domain, record the screencast and submit. Review then runs for weeks, during which you and your testers use the real connection and everyone else uses manual upload.
