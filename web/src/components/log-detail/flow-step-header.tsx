interface FlowStepHeaderProps {
  step: number;
  title: string;
  description: string;
}

export function FlowStepHeader({ step, title, description }: FlowStepHeaderProps) {
  return (
    <div className="flex items-start gap-3 border-b px-3 py-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {step}
      </div>
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
