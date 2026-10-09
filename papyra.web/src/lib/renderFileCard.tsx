import type { ReactNode } from 'react';
import type { FileCardContext } from '@lyfie/luthor-headless';
import FileCard from '../components/FileCard';

/** The adapters' `renderFileCard`: every document is drawn as its desktop icon and name. */
export function renderFileCard(ctx: FileCardContext): ReactNode {
  return <FileCard {...ctx} />;
}
