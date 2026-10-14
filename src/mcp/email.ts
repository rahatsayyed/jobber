import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendEmail } from '../email.js';

const server = new McpServer({ name: 'email', version: '0.1.0' });

server.registerTool(
  'send_email',
  {
    description: 'Send an email via Gmail SMTP, optionally with an attachment',
    inputSchema: {
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      attachment_path: z.string().optional(),
    },
  },
  async ({ to, subject, body, attachment_path }) => {
    const { message_id } = await sendEmail({ to, subject, body, attachment_path });
    return {
      content: [{ type: 'text', text: JSON.stringify({ message_id }) }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[email] fatal error:', err);
  process.exit(1);
});
