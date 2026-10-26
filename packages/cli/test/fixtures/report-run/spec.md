# web-app: migrate to a new component library

## Goal

Replace the old in-house component library in `web-app` with a shadcn/ui based one, page by page,
without changing what users see or how the pages behave.

## Scope

- One setup child installs the library, theme and shared components.
- One child per page area moves that area to the new components.
