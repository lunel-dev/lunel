// Extra plugins loaded into the production app build.
// Keep this aligned with the surface exposed from the tabs launcher.

import './explorer';
import './brainrot';
import './git';
import './ports';
import './processes';
import './http';
import './monitor';
import './tools';

export { ExplorerPanel } from './explorer';
export { BrainrotPanel } from './brainrot';
export { GitPanel } from './git';
export { PortsPanel } from './ports';
export { ProcessesPanel } from './processes';
export { HttpPanel } from './http';
export { MonitorPanel } from './monitor';
export { ToolsPanel } from './tools';
