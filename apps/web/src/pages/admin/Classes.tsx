import { AddClassForm } from "../../components/AddClassForm";
import { ClassRoster } from "../../components/ClassRoster";

/**
 * `/admin/classes` (M16): the deleted `Admin.tsx`'s "Classes" section,
 * `AddClassForm` and `ClassRoster` mounted exactly as they were there (the
 * dry-run panel stays nested per class, inside `ClassRoster`).
 */
export function AdminClassesPage() {
  return (
    <div className="flex flex-col gap-6">
      <AddClassForm />
      <ClassRoster />
    </div>
  );
}
