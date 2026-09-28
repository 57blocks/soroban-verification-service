import { Toaster as Sonner } from "sonner";

export const Toaster = (props: React.ComponentProps<typeof Sonner>) => (
  <Sonner
    position="top-center"
    toastOptions={{
      classNames: {
        toast:
          "rounded-lg border border-line-strong bg-surface px-4 py-3 text-[0.875rem] font-medium text-ink shadow-panel font-sans",
        description: "text-ink/[0.66]",
        success: "border-success-line",
        error: "border-danger-line",
        warning: "border-warning-line",
      },
    }}
    {...props}
  />
);
