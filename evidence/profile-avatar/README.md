# Profile avatar upload — screenshots

before = 2ee0c0eb28b5bd7506fd73163d26a75918ffb230 (upstream master when cut)
after = the PR tip; 24 shots = 3 states x zh-CN/en x light/dark x 1440x900/390x844
before has 8 shots: only the no-avatar state exists on the base commit.

Every shot is exactly its viewport (1440x900 or 390x844) and documentElement.scrollWidth equals the viewport in all 32 captures.

## Readings

- state 1 (01-no-avatar.png): the edit page before any upload. 更换头像 is an enabled button, the hidden file input accepts PNG/JPG, and the monogram stands in for the missing avatar.
- state 2 (02-avatar-after-upload.png): after choosing avatar.png the page reports 头像已更新。, then the page is reloaded and the image must still be visible with the same /v1/profile/avatar URL. All 8 reloads kept it.
- state 3 (03-over-limit.png): choosing a 2,101,156-byte PNG makes the server answer 413 and the page shows 头像不能超过 2 MB。; the previously saved avatar stays visible.
- state 1 (01-no-avatar.png): the base page only has the disabled placeholder (title 未接通：还没有头像上传接口, no file input).
- states 2 and 3 cannot exist on the base commit: there is no avatar route and no handler, so nothing can be uploaded and no reason can be shown. tests/test_profile_avatar.py fails there with 404 vs 200 / 404 vs 413 / 404 vs 415 and KeyError: avatar.

## Files

| file | size | sha256 (16) |
| --- | --- | --- |
| before/en__dark__1440x900/01-no-avatar.png | 1440x900 | `078a0fbe6bfce08c` |
| before/en__dark__390x844/01-no-avatar.png | 390x844 | `0575d9d7d0e27cd4` |
| before/en__light__1440x900/01-no-avatar.png | 1440x900 | `2ff3c177d2ffc5be` |
| before/en__light__390x844/01-no-avatar.png | 390x844 | `80dca13493c54d62` |
| before/zh-CN__dark__1440x900/01-no-avatar.png | 1440x900 | `078a0fbe6bfce08c` |
| before/zh-CN__dark__390x844/01-no-avatar.png | 390x844 | `e4f7a07255c7f1f6` |
| before/zh-CN__light__1440x900/01-no-avatar.png | 1440x900 | `8057744967036479` |
| before/zh-CN__light__390x844/01-no-avatar.png | 390x844 | `7d6289e24d1e9aa8` |
| after/en__dark__1440x900/01-no-avatar.png | 1440x900 | `69ec3f2984f74704` |
| after/en__dark__1440x900/02-avatar-after-upload.png | 1440x900 | `92cd4893e1273a7a` |
| after/en__dark__1440x900/03-over-limit.png | 1440x900 | `44e143b9be67267b` |
| after/en__dark__390x844/01-no-avatar.png | 390x844 | `087e8ed3180402ea` |
| after/en__dark__390x844/02-avatar-after-upload.png | 390x844 | `6d7d0bacd5b29421` |
| after/en__dark__390x844/03-over-limit.png | 390x844 | `c5d54be4b3c54b8a` |
| after/en__light__1440x900/01-no-avatar.png | 1440x900 | `fa5a83daa51210e9` |
| after/en__light__1440x900/02-avatar-after-upload.png | 1440x900 | `4c067d3247cbf5b0` |
| after/en__light__1440x900/03-over-limit.png | 1440x900 | `45871cdad2fb42fb` |
| after/en__light__390x844/01-no-avatar.png | 390x844 | `88cc304075a0c238` |
| after/en__light__390x844/02-avatar-after-upload.png | 390x844 | `656ae5e5fcdc45fc` |
| after/en__light__390x844/03-over-limit.png | 390x844 | `67b8ede0f48f1c05` |
| after/zh-CN__dark__1440x900/01-no-avatar.png | 1440x900 | `69ec3f2984f74704` |
| after/zh-CN__dark__1440x900/02-avatar-after-upload.png | 1440x900 | `a961654e605cd488` |
| after/zh-CN__dark__1440x900/03-over-limit.png | 1440x900 | `27f36c91b82d9f85` |
| after/zh-CN__dark__390x844/01-no-avatar.png | 390x844 | `087e8ed3180402ea` |
| after/zh-CN__dark__390x844/02-avatar-after-upload.png | 390x844 | `d44201df249eaee5` |
| after/zh-CN__dark__390x844/03-over-limit.png | 390x844 | `174b1f74aaac8e37` |
| after/zh-CN__light__1440x900/01-no-avatar.png | 1440x900 | `2656821c88a0cc8f` |
| after/zh-CN__light__1440x900/02-avatar-after-upload.png | 1440x900 | `52b1f1181c9ccf19` |
| after/zh-CN__light__1440x900/03-over-limit.png | 1440x900 | `445d2b936b70a92f` |
| after/zh-CN__light__390x844/01-no-avatar.png | 390x844 | `88cc304075a0c238` |
| after/zh-CN__light__390x844/02-avatar-after-upload.png | 390x844 | `656ae5e5fcdc45fc` |
| after/zh-CN__light__390x844/03-over-limit.png | 390x844 | `67b8ede0f48f1c05` |
