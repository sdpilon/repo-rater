import { MetaProvider } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { ErrorBoundary, Suspense } from "solid-js";
import "./app.css";

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <ErrorBoundary
            fallback={(err, reset) => (
              <div class="wrap">
                <header class="page">
                  <h1>Something went wrong</h1>
                  <p class="credential-error">{err instanceof Error ? err.message : String(err)}</p>
                </header>
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    window.location.href = "/";
                  }}
                >
                  Back to settings
                </button>
              </div>
            )}
          >
            <Suspense>{props.children}</Suspense>
          </ErrorBoundary>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
