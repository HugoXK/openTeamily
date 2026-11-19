# Consolidated functional delivery and complete gap checklist

Related: #1 #4 #5 #6 #7 #8 #9 #10 #11 #12 #14 #86 #87 #88 #89 #90 #91 #130 #157.

This broad functional PR combines chat, search, discovery, media and profile persistence. It is
**not all-feature completion or Teamily + Impeccable acceptance**. The matrix retains every capability
area from the 2026-11-19 parity audit; external dependencies are not scope exclusions. A distinct UI
repair PR follows functional review; controls here use existing components/native controls, not a redesign.

## Implemented in this PR, end to end

- [x] Durable per-user human/social conversation unread counts, actual session badges, snapshot-bounded
  read acknowledgement. Own messages do not increment unread; retracted bodies are excluded.
- [x] Private social conversation pins and real loaded-list filters: all, groups, DMs, unread, read, pinned.
- [x] Author-only human message edit/retract with revision conflicts, inline editing, confirm retraction,
  erased searchable body and honest tombstones. Existing explicit group-agent reply protocol retained.
- [x] Social message image/audio/video upload → workspace-library artifact → message reference → authorized
  download, same-workspace validation and normal idempotency. Workspace visibility is explicitly warned.
- [x] Independent in-conversation search panel with real scope and cursor paging, separate from sidebar.
- [x] Authorized file/HTTP(S)-link resource search with sidebar tabs and paging. No server URL fetching.
- [x] Discover real type filters combined with search/cursors: website, image, audio, video, slides and API
  support for document, whiteboard, dashboard/media. Unsupported classifications are not fake filters.
- [x] Real idempotent like/unlike, collect/uncollect, author follow/unfollow; real counts and private flags.
- [x] Real following and collected-work feeds; private tab scope combines with search/types/pagination;
  unlisting hides the work from every feed. Self-follow is rejected; anonymous users see no private state.
- [x] Explicitly listed image/audio/video public view and byte download, native player, restrictive CSP,
  MIME sniffing and per-request revocation checks. Publishing warning states public media visibility.
- [x] Private three-section memory profile GET/save/reload per workspace and user, optimistic revisions.
  No invented generated text or silent injection into model prompts.
- [x] Search in-flight race regression and stale Discover-tab response protection.

## Complete remaining-domain matrix (not silently dropped)

| Domain / audit gap | Already usable / this delivery | Still pending; dependency or boundary |
|---|---|---|
| Chat #4 #86 | Human/agent/group messaging; this PR adds social unread, pins/filters, edit/retract, media | Message reactions (fixed six-emoji set, counts, mine, retraction-aware) and @mention notification center (badge, list, mark one/all read, cleared by reading the conversation; retracted/left-conversation hidden) is now usable. Still pending: user-agent unread; task-completion aggregation, push/live delivery; translation, forwarding/multiselect, message-level pin and ask-AI; link-preview settings behavior; richer toolbar/agent attachment context |
| Access/collaboration #5 | Workspace membership and invitation-link APIs exist | Invite approval (pending join requests approved/rejected by owner/admin, reserved uses, re-request after rejection) and invite freeze/resume are now implemented with tests. Still pending: two-person invite/accept flow inside chat, member-level suspension, comparison evidence |
| Agents/public conversation #6 #192 | Stored public starters can launch an authenticated member conversation (#206) | Anonymous typed public chat, external channels and full public composer; no unrequested model call |
| Teams/groups #7 #89 | Stored groups and explicit selected-agent runtime requests | Public AI-team data/templates/search/create; complete collaboration execution; no import of competing #126/#131 protocol |
| Memory #8 #179 | Pages/actions/graph; private profile editing here | Dreaming/generated profiles, explicit prompt integration and comparison acceptance |
| Works/Studio #9 #90 | Existing supported artifacts; opt-in public works (#209); media content here | Remaining richer Studio workflows and same-state comparison, not a completeness claim from rendering |
| Meetings #9 #12 #157 | Navigation/empty state only | Real meeting records, capture/consent, transcription, summaries and action extraction; transport/runtime/storage design and tests first; live external service use/recording needs permission |
| Discover/profile #87 #12 #130 | Real public works, type/search/paging, likes/collections/follows here | Recommendations/ranking/comments, social profile avatar/posts/follower views, public agent-directory chat; no fabricated totals or recommendation data |
| Search #88 | Authorized messages, independent panel and media/link resources here | Arbitrary document extraction/indexing and broader attachment content; only supported data is searchable |
| Connectors/channels/MCP #10 | Catalog/navigation and settings records only | Provider OAuth app registration/token lifecycle, actual account connection and MCP execution/scopes/audit; engineering is still needed. Connecting external accounts requires explicit permission, never credential discovery |
| Agent API/runtime #11 #2 | Existing management/runtime claim/model-access/result contracts | External-caller gateway keys, scopes, rate limits/audit and full safe invocation contract; no production deployment permission |
| Onboarding/personal agent #130 #157 | Step 1 work context, stored assistants | Steps 2–4, application setup, task/routine recommendations and appearance; later-step read-only layout evidence needed, no fake completion |
| Scheduling/automation #6 #91 | Existing schedules/edit/run history, readable schedule #211 | Recorded real scheduler → container/vendor/browser E2E; fake provider tests are not acceptance |
| Real-time voice/video/camera #12 #157 | Unconnected controls remain honestly marked | Runtime/media contracts, capture consent, WebRTC lifecycle, TURN/STUN/security, voice input and tests; actual external transport/recording needs permission, not excluded |
| Real vendor inference #91 #2 #11 | Fake provider/runtime protocol tests only | Safe owner-provided sandbox/provider configuration plus explicit permission, then actual recorded container/browser E2E; no discovery/use of credentials or production deployment |
| Settings/help/legal #4 #12 #128 | Existing settings persistence and Guide | Behavioral validation of saved toggles, help/legal pages with owner-supplied original text; never copy proprietary legal copy |
| Full UI acceptance #14 | Existing read-only evidence available; no redesign in this PR | One comprehensive separate UI repair PR, followed by Teamily + Impeccable evaluation; no entire page currently accepted |

## Tests, privacy and migration

Additive SQLite tables retain `user_version=1`; no destructive migration or dependencies. Authenticated
writes retain exact Origin + session + CSRF; resource reads retain workspace/conversation membership.
Revision checks serialize within existing immediate transactions. UI uses `textContent` for user data.
Media uses existing sniff/size/path/digest checks; only explicit Discover publication exposes bytes.
No secrets/proprietary assets, vendor modifications, OAuth, inference calls or deployments are added.

Tests include temporary-DB permission/CSRF/revision/idempotency cases, media upload/download/revoke,
private profile/engagement isolation, mounted browser-controller actions and CI synthetic browser
profile persistence/Discover interactions. Test and CI evidence must be read at the exact PR head.
All umbrella/unaccepted issues remain open. CI is not vendor or visual parity acceptance.

Explicit exclusions remain credits/points/cash/rewards/usage/plans/upgrades, proprietary Teamily
assets/text/prompts, Teamily-hosted computer services and native clients. Project/Timeline is not a
substitute for core product scope. OAuth, A/V, social features and real inference are NOT excluded.
