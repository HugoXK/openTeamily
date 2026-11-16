# Reuse and provenance policy

This repository contains independently authored management code, documentation and repository metadata. No original FlyBot/Bot Social code, compiled bundle, dependencies, screenshots, credentials, account state or git history is included.

Before reusing any source, image or dependency:

1. Identify the exact repository/image, version, public/private status, owner and provenance.
2. Read the actual license and notices for that revision, including third-party and upstream runtime components.
3. Establish redistribution and modification rights. Public availability is not itself a license; organization membership is not permission to republish private material.
4. Record attribution, notice/source-distribution obligations, compatibility, image dependencies and security implications.
5. Choose an adapter or clean independent implementation when reuse is not justified. Do not relicense upstream work under this repository's MIT license.
6. Import only the minimal approved capability in an independently reviewed PR, with tests and a migration plan.

Runtime-container reuse is an architectural option pending this review, not an import authorization. Assess project/timeline by evidence rather than blanket inclusion or removal. Keep secrets, logs, user content, caches and generated mock screenshots out of git.

No upstream runtime/image import has passed a complete dependency/license audit. The management slice uses the Python standard library and adds no third-party application package.
