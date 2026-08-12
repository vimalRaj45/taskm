import dotenv from 'dotenv';
import { ProjectRecord, TaskRecord } from '../db/index.js';

dotenv.config();

export interface ProposalItem {
  id: string;
  type: 'CREATE_TASK' | 'COMPLETE_TASK' | 'UPDATE_TASK' | 'DELETE_TASK' | 'CREATE_PROJECT';
  title?: string;
  name?: string;
  priority?: 'Low' | 'Medium' | 'High' | 'Urgent';
  dueDate?: string;
  status?: string;
  targetTaskId?: string;
  projectId?: string;
  client?: string;
}

export interface AIResponse {
  message: string;
  actionType: 'PROPOSAL' | 'READ_ONLY';
  proposals: ProposalItem[];
}

export async function generateAIChatResponse(
  userPrompt: string,
  userTasks: TaskRecord[],
  userProjects: ProjectRecord[]
): Promise<AIResponse> {
  const apiKey = process.env.MISTRAL_API_KEY;
  const todayDate = new Date().toISOString().split('T')[0];

  // Call Mistral AI API if valid API key is set
  if (apiKey && !apiKey.includes('your_mistral_api_key')) {
    try {
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'mistral-small-latest',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `You are an AI Daily Work Assistant & Productivity Copilot.
Today's date is: ${todayDate}

USER CONTEXT:
Projects: ${JSON.stringify(userProjects)}
Tasks: ${JSON.stringify(userTasks)}

CRITICAL EASY-MODE RULES:
1. FRICTIONLESS & INSTANT: NEVER ask clarifying questions. If the user prompt mentions any task, meeting, call, project, note, or idea (e.g. "meeting", "call sarah", "landing page", "buy domain"), IMMEDIATELY construct a ready-to-approve task or project proposal in proposals array!
2. READ-ONLY Queries ("Do I have tasks this week?", "What is urgent?", "Plan my day"): Provide concise markdown briefing, actionType = "READ_ONLY", proposals = [].
3. ANY OTHER INPUT: Generate exact proposal items in proposals array, set actionType = "PROPOSAL". Use sensible defaults (due date today, priority Medium/Urgent as requested).

RETURN FORMAT (Strict JSON):
{
  "message": "Friendly 1-line response confirming proposal...",
  "actionType": "PROPOSAL" | "READ_ONLY",
  "proposals": [
    {
      "id": "prop-1",
      "type": "CREATE_TASK" | "COMPLETE_TASK" | "UPDATE_TASK" | "DELETE_TASK" | "CREATE_PROJECT",
      "title": "Clear task title",
      "priority": "Low" | "Medium" | "High" | "Urgent",
      "dueDate": "YYYY-MM-DD",
      "status": "Todo" | "In Progress" | "Completed" | "Active",
      "targetTaskId": "UUID of target task if updating",
      "client": "Client name if project"
    }
  ]
}`,
            },
            {
              role: 'user',
              content: userPrompt,
            },
          ],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const rawContent = data.choices?.[0]?.message?.content;
        if (rawContent) {
          const parsed = JSON.parse(rawContent) as AIResponse;
          if (parsed.message && parsed.actionType) {
            return parsed;
          }
        }
      }
    } catch (err) {
      console.warn('Mistral AI call failed, switching to Rule-Based NLP fallback parser:', err);
    }
  }

  // Graceful Rule-Based NLP Fallback
  return ruleBasedFallbackParser(userPrompt, userTasks, userProjects, todayDate);
}

function ruleBasedFallbackParser(
  prompt: string,
  userTasks: TaskRecord[],
  userProjects: ProjectRecord[],
  todayDate: string
): AIResponse {
  const lower = prompt.toLowerCase().trim();

  // 1. "Plan my day" / "Show today" / "What is urgent"
  if (lower.includes('plan my day') || lower.includes('what is urgent') || lower.includes('show today') || lower.includes('my tasks')) {
    const urgentTasks = userTasks.filter((t) => (t.priority === 'Urgent' || t.priority === 'High') && t.status !== 'Completed');
    const todayTasks = userTasks.filter((t) => t.due_date === todayDate && t.status !== 'Completed');
    const overdueTasks = userTasks.filter((t) => t.due_date && t.due_date < todayDate && t.status !== 'Completed');

    let msg = `### 📋 Daily Briefing for ${todayDate}\n\n`;
    if (overdueTasks.length > 0) {
      msg += `🚨 **${overdueTasks.length} Overdue Task(s)**:\n` + overdueTasks.map((t) => `- [ ] ${t.title} (Due ${t.due_date})`).join('\n') + '\n\n';
    }
    if (urgentTasks.length > 0) {
      msg += `⚡ **High Priority Tasks**:\n` + urgentTasks.map((t) => `- [ ] ${t.title} (*${t.priority}*)`).join('\n') + '\n\n';
    }
    if (todayTasks.length > 0) {
      msg += `📅 **Due Today**:\n` + todayTasks.map((t) => `- [ ] ${t.title}`).join('\n') + '\n\n';
    }
    if (overdueTasks.length === 0 && urgentTasks.length === 0 && todayTasks.length === 0) {
      msg += `✨ All clear! You have no pending urgent or overdue tasks today.`;
    }

    return {
      message: msg,
      actionType: 'READ_ONLY',
      proposals: [],
    };
  }

  // 2. Complete / Finished / Done task
  if (lower.startsWith('finished') || lower.startsWith('done') || lower.startsWith('complete') || lower.includes('mark completed')) {
    const searchKeyword = lower.replace(/^(finished|done|complete|mark completed)\s+/i, '').replace(/^(the|task)\s+/i, '');
    const matchedTask = userTasks.find((t) => t.title.toLowerCase().includes(searchKeyword) && t.status !== 'Completed') || userTasks.find((t) => t.status !== 'Completed');

    if (matchedTask) {
      return {
        message: `I've prepared a proposal to mark **"${matchedTask.title}"** as **Completed**.`,
        actionType: 'PROPOSAL',
        proposals: [
          {
            id: `prop-${Date.now()}`,
            type: 'COMPLETE_TASK',
            title: matchedTask.title,
            targetTaskId: matchedTask.id,
            status: 'Completed',
          },
        ],
      };
    }
  }

  // 3. Create Project
  if (lower.includes('create project') || lower.includes('new project') || lower.startsWith('project ')) {
    const projName = prompt.replace(/(create|new)\s+project\s*/i, '').trim() || 'New Client Project';
    return {
      message: `I've created a proposal to register a new project titled **"${projName}"**.`,
      actionType: 'PROPOSAL',
      proposals: [
        {
          id: `prop-${Date.now()}`,
          type: 'CREATE_PROJECT',
          name: projName,
          client: 'Client Partner',
          dueDate: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
          status: 'Active',
        },
      ],
    };
  }

  // 4. Default: Instant zero-question task proposal generation for ANY user prompt
  const cleanTitle = prompt.replace(/^(add|create|remind me to|schedule|task)\s*/i, '').trim() || prompt.trim();
  const formattedTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
  const isUrgent = lower.includes('urgent') || lower.includes('asap') || lower.includes('critical');
  const isHigh = lower.includes('important') || lower.includes('high');
  const priority = isUrgent ? 'Urgent' : isHigh ? 'High' : 'Medium';

  const isTomorrow = lower.includes('tomorrow');
  const dueDate = isTomorrow
    ? new Date(Date.now() + 86400000).toISOString().split('T')[0]
    : todayDate;

  return {
    message: `⚡ Prepared a proposal to add task **"${formattedTitle}"** (${priority} priority). Click Approve to save it instantly.`,
    actionType: 'PROPOSAL',
    proposals: [
      {
        id: `prop-${Date.now()}`,
        type: 'CREATE_TASK',
        title: formattedTitle,
        priority: priority,
        dueDate: dueDate,
        status: 'Todo',
        projectId: userProjects[0]?.id || undefined,
      },
    ],
  };
}
