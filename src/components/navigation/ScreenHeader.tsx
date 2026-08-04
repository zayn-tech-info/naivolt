/**
 * ScreenHeader — a back affordance and a title.
 *
 * The stack renders headerShown:false throughout, so each pushed screen was
 * drawing its own header slightly differently. This is that header, once.
 */

import { FlowHeader, type FlowHeaderProps } from '@/components/ui';

export type ScreenHeaderProps = FlowHeaderProps;

export function ScreenHeader({ title, onBack, action }: ScreenHeaderProps) {
  return <FlowHeader title={title} onBack={onBack} action={action} />;
}

export default ScreenHeader;
