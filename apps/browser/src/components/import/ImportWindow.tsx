import { AccessStep, ChooseStep, DiaStep, DoneStep, LoadingStep, ProfilesStep, ProgressStep, SafariStep, UnlockStep } from "./steps";
import { ImportBackdrop } from "./ui";
import { useImportFlow, type ImportFlow, type Step } from "./useImportFlow";

const STEPS: Record<Step, (props: { flow: ImportFlow }) => React.ReactNode> = {
  loading: LoadingStep,
  choose: ChooseStep,
  profiles: ProfilesStep,
  unlock: UnlockStep,
  safari: SafariStep,
  access: AccessStep,
  dia: DiaStep,
  progress: ProgressStep,
  done: DoneStep,
};

export function ImportWindow() {
  const flow = useImportFlow();
  const CurrentStep = STEPS[flow.step];
  return (
    <ImportBackdrop>
      <CurrentStep flow={flow} />
    </ImportBackdrop>
  );
}
