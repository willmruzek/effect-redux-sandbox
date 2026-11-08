# Workspace applications

Each app is a pnpm workspace package and owns its store, toolkit, middleware,
Effect workflows, GraphQL lifecycle engine, runtime ownership and React
integration. Keep Redux/custom-store implementations and their tests app-local.

Only store-independent UI, domain data, fake APIs, GraphQL utilities and
lint/TypeScript configuration belong in shared packages. See the
[workspace README](../README.md) for dispatch contracts and demo behavior.
