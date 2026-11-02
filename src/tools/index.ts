import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCourseTools } from './courses.js';
import { registerContentTools } from './content.js';
import { registerFileTools } from './files.js';
import { registerGradeTools } from './grades.js';
import { registerDeadlineTools } from './deadlines.js';
import { registerCommsTools } from './comms.js';
import { registerZoomTools } from './zoom.js';
import { registerRawTools } from './raw.js';

export function registerAllTools(server: McpServer): void {
  registerCourseTools(server);
  registerContentTools(server);
  registerFileTools(server);
  registerGradeTools(server);
  registerDeadlineTools(server);
  registerCommsTools(server);
  registerRawTools(server);
  registerZoomTools(server);
}

export * from './helpers.js';
