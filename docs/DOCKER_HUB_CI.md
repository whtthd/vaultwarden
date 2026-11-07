# Docker Hub CI

`.github/workflows/docker-publish.yml` builds the PostgreSQL image on a
GitHub-hosted runner. The workflow does not compile on the production server.
It also prepares the pinned `2026.10.1` web-vault bundle and applies the
production collection, permission, navigation and subtree enhancements before
the bundle is copied into the image.

Configure these values in the repository settings:

| Type | Name | Example |
| --- | --- | --- |
| Repository variable | `DOCKERHUB_REPOSITORY` | `iris/vaultwarden-custom` |
| Repository secret | `DOCKERHUB_USERNAME` | Docker Hub login name |
| Repository secret | `DOCKERHUB_TOKEN` | Docker Hub access token with push permission |

The secret must be a Docker Hub access token rather than a personal password.
The repository variable is intentionally separate from the credentials so the
image destination remains visible in workflow configuration without exposing
the token.

The workflow runs on changes to the server, migrations, Docker files, web-vault
enhancement code and the workflow itself. Pull requests build and validate the
image but do not push it. A push to `main` publishes `latest`, `main` and a
short commit tag. A version tag such as `v1.35.5` publishes the tag-derived
image tag as well as the commit tag. The image is currently built for
`linux/amd64`, matching the existing `88.204` production server.

The build uses `DB=postgresql` and leaves the local development unlock behavior
disabled. The pinned upstream web-vault asset is extracted from its immutable
image digest, then checked by `tools/prepare_web_vault.py` and the frontend
tests before the Docker build starts.

After a successful run, use the image digest shown in the GitHub Actions
summary for deployment. Keep the existing database dump, attachments,
configuration and encryption keys separate from the image. Do not deploy
`latest` by digestless tag when an exact rollback point is required.
