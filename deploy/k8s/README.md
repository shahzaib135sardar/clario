# Kubernetes deployment

Written to Kubernetes best practice but **not run against a real cluster** from the authoring
environment. Review it, run `kubectl apply --dry-run=server -k deploy/k8s` first, and adjust the
image name, host name and ingress class.

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl -n clario create secret generic clario-secrets --from-env-file=.env.production   # never commit this file
kubectl apply -k deploy/k8s
kubectl -n clario rollout status deploy/clario
```

## Probes
- `/healthz` (liveness, startup): process is up; touches no dependency, so an outage of Redis/Supabase never restarts pods.
- `/readyz` (readiness): checks config, Redis and Supabase; returns 503 while the pod is draining.

## Rolling deploys and rollback
`maxUnavailable: 0, maxSurge: 1` replaces pods one at a time, each only after it is Ready.
```bash
kubectl -n clario set image deploy/clario clario=ghcr.io/OWNER/clario:<sha>
kubectl -n clario rollout undo deploy/clario          # roll back to the previous revision
```

## Blue-green
Run a second Deployment `clario-green` with labels `app: clario, track: green` (copy of `deployment.yaml`).
Test it through a temporary Service, then switch live traffic by changing the Service selector to
`track: green`. Rolling back is changing it back.

## Canary
Run `clario-canary` with `replicas: 1` and the same `app: clario` label: the Service spreads traffic across
all pods, so roughly 1 / (stable + 1) of requests reach the canary. For percentage control per user inside
the app, use the `FEATURE_<NAME>=percent` flags (a stable hash picks the cohort).
