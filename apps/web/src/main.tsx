import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./routes";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // An admin watching a queue wants the current answer, not a cached one.
      staleTime: 0,
      // Retrying a request that failed because the Access session expired just
      // delays the redirect the user actually needs. Task 6 makes that failure
      // a typed error; retry is disabled here so it surfaces immediately.
      retry: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
