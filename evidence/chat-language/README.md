# Chat language reaches the model (issue #319 / PR #320)

Captured with the in-repo loopback fixture (`scripts/ci_ui_screenshots.py --serve`): a
throwaway app on 127.0.0.1, the repo's fake OpenAI-compatible provider and the repo's
fake runtime daemon. The reply text in the chat images is that fixture's canned
sentence — **not** a vendor response. No real model was contacted.

- `before` tree = `2ee0c0eb28b5bd7506fd73163d26a75918ffb230` (live main, PR base)
- `after` tree = `bc726e006ced26d8159a6654fd461eb09a0bc780` (PR tip)
- Browser: chromium 1255 via playwright; viewport 1440×900 and 390×844; light theme.

## What each image shows

| File | What it is |
|---|---|
| `settings-language-before-1440x900.png` | `/settings/language` on the base tree, chat language 简体中文. There is no explanation line at all (`#chat-language-effect` does not exist). |
| `settings-language-before-390x844.png` | the same base page at 390×844. |
| `settings-language-after-1440x900.png` | `/settings/language` on the PR tip with chat language English: the new line under the select reads 「发消息时会带上「English」：智能体按这个语言回复。」 |
| `settings-language-after-390x844.png` | the same page at 390×844; the sentence wraps to two lines, no horizontal overflow. |
| `chat-send-before-1440x900.png` | `/chat` on the base tree after sending 「[CI FIXTURE] 这条消息用来观察请求体里的聊天语言。」 — the recorded request body is `{"body":"…"}` only. |
| `chat-send-after-1440x900.png` | the same action on the PR tip with chat language English — the recorded request body is `{"body":"…","chat_language":"en"}`, and the runtime task prompt that reached the agent starts with `You are …\nReply in English.` |

## DOM / request readings

`before-chat-language-states.json` and `after-chat-language-states.json` hold, per cell:
the note element's presence and text, the selected language, the note's bounding box and
viewport height, horizontal overflow (`scrollWidth − clientWidth`), page errors, the POST
bodies the composer actually sent, the last message-bubble text, and the prompt of the
last `infer` task the runtime claimed (read from `runtime_tasks` in that run's throwaway
database).

Key readings, verbatim:

- before: `noteExists: false`, `posts: [{"body":"[CI FIXTURE] …"}]`,
  `runtime_task_prompt` has no `Reply in` line.
- after: `noteExists: true`,
  `note: "发消息时会带上「English」：智能体按这个语言回复。"`,
  `posts: [{"body":"[CI FIXTURE] …","chat_language":"en"}]`,
  `runtime_task_prompt` starts `You are [CI FIXTURE] Directory assistant.\nReply in English.\n…`.

Every cell reports `overflow: 0` and no page error.

## Not claimed

This is not Teamily comparison, not a real model or real vendor response, and not a
translation catalogue: only the reply language is stated in the prompt. The `en` locale
cells are not a translation of the page (the settings page has Chinese copy only); the
screenshot set therefore carries no `en` cells.
