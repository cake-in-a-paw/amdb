import { Button } from '@/components/ui/button';

/**
 * What a page that failed to load or render shows instead of the router's default. A reload is the
 * way out of the usual cause: after a redeploy an open tab asks for route files that no longer exist.
 */
export function RouteError() {
  return (
    <div role="alert" className="py-12">
      <h1 className="font-serif text-3xl font-semibold">Something went wrong loading this page.</h1>
      <p className="mt-3 text-muted-foreground">
        AMDB may have been updated since you opened it. Reloading usually fixes this.
      </p>
      <Button className="mt-6" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
