import { JobList } from "../components/JobList";
import { SubmitForm } from "../components/SubmitForm";

export function Admin() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Submit a video
        </h2>
        <SubmitForm />
      </section>
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[var(--color-text-muted)]">
          Queue
        </h2>
        <JobList />
      </section>
    </main>
  );
}
