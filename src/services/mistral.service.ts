import dotenv from 'dotenv';
import { ProjectRecord, TaskRecord } from '../db/index.js';

dotenv.config();

export interface ProposalItem {
  id: string;
  type:
    | 'CREATE_TASK'
    | 'COMPLETE_TASK'
    | 'UPDATE_TASK'
    | 'DELETE_TASK'
    | 'CREATE_PROJECT'
    | 'ADD_SUBTASK'
    | 'ADD_NOTE';
  title?: string;
  name?: string;
  description?: string;
  priority?: 'Low' | 'Medium' | 'High' | 'Urgent' | 'Critical';
  dueDate?: string;
  dueTime?: string;
  status?: string;
  category?: string;
  tags?: string;
  estimatedDuration?: string;
  isImportant?: boolean;
  subtasks?: string[];
  notes?: string;
  targetTaskId?: string;
  targetTaskTitle?: string;
  subtaskTitle?: string;
  noteContent?: string;
  projectId?: string;
  client?: string;
  requiresConfirmation?: boolean;
}

export interface ConversationContext {
  focusedTaskId?: string;
  focusedTaskTitle?: string;
  lastTaskId?: string;
  lastTaskTitle?: string;
  lastList?: Array<{ id: string; title: string; priority?: string; status?: string; due_date?: string }>;
}

export interface AIResponse {
  message: string;
  actionType: 'PROPOSAL' | 'READ_ONLY' | 'DISAMBIGUATE' | 'CONFIRM_DELETION';
  proposals: ProposalItem[];
  sqlQuery?: string;
  candidates?: any[];
  focusedTaskId?: string;
  focusedTaskTitle?: string;
}

export interface SQLGenerationResult {
  isAction: boolean;
  sql: string;
  params: any[];
  proposals?: ProposalItem[];
  targetEntity?: 'TASKS' | 'PROJECTS';
  focusedTaskId?: string;
  focusedTaskTitle?: string;
  actionType?: 'PROPOSAL' | 'READ_ONLY' | 'DISAMBIGUATE' | 'CONFIRM_DELETION';
  candidates?: any[];
}

/**
 * Robust Typo & Natural Language Date Parser
 * Handles "tomorrow", "tommorw", "tomorow", "tomrw", "tday", "next week", "friday", etc.
 */
export function parseFuzzyDate(text: string, baseDate: string): string | null {
  const lower = text.toLowerCase();
  const explicit = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit) return explicit[1];

  const now = new Date(baseDate);
  if (/\b(today|tday|tonight)\b/i.test(lower)) {
    return baseDate;
  }
  if (/\b(tomorrow|tommorw|tomorow|tomrw|tmrw|tmr|2mrw)\b/i.test(lower)) {
    const d = new Date(now.getTime() + 86400000);
    return d.toISOString().split('T')[0];
  }
  if (/\b(day\s+after\s+tomorrow|overmorrow)\b/i.test(lower)) {
    const d = new Date(now.getTime() + 2 * 86400000);
    return d.toISOString().split('T')[0];
  }
  if (/\b(next\s+week)\b/i.test(lower)) {
    const d = new Date(now.getTime() + 7 * 86400000);
    return d.toISOString().split('T')[0];
  }

  // Weekdays e.g. "friday", "next friday", "mon", "fri"
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < days.length; i++) {
    const dayName = days[i];
    const dayShort = dayName.slice(0, 3);
    const regex = new RegExp(`\\b(next\\s+)?(${dayName}|${dayShort})\\b`, 'i');
    if (regex.test(lower)) {
      const currentDay = now.getDay();
      let diff = i - currentDay;
      if (diff <= 0) diff += 7;
      const targetDate = new Date(now.getTime() + diff * 86400000);
      return targetDate.toISOString().split('T')[0];
    }
  }

  return null;
}

/**
 * Text-to-SQL Generator: Translates Natural Language into a safe, parameterized SQL Query
 * Supports Contextual Pronouns ("it", "the second one", "that task"), Subtasks, Notes, and Disambiguation
 */
export function generateSQLForUserQuery(
  prompt: string,
  todayDate: string,
  context?: ConversationContext
): SQLGenerationResult {
  const lower = prompt.toLowerCase().trim();

  // 1. Resolve Contextual Task Reference (Pronoun resolution: "it", "that task", "the second one", or modal focused task)
  let mentionedTaskTitle: string | null = null;
  let targetTaskId: string | null = null;

  if (context?.focusedTaskId) {
    targetTaskId = context.focusedTaskId;
    mentionedTaskTitle = context.focusedTaskTitle || 'Current Task';
  }

  // Ordinal list reference e.g. "the second one", "the 2nd one", "the first task"
  if (!targetTaskId && context?.lastList && context.lastList.length > 0) {
    if (lower.includes('first') || lower.includes('1st')) {
      mentionedTaskTitle = context.lastList[0]?.title || null;
      targetTaskId = context.lastList[0]?.id || null;
    } else if ((lower.includes('second') || lower.includes('2nd')) && context.lastList.length > 1) {
      mentionedTaskTitle = context.lastList[1]?.title || null;
      targetTaskId = context.lastList[1]?.id || null;
    } else if ((lower.includes('third') || lower.includes('3rd')) && context.lastList.length > 2) {
      mentionedTaskTitle = context.lastList[2]?.title || null;
      targetTaskId = context.lastList[2]?.id || null;
    }
  }

  // Pronoun reference e.g. "it", "that task", "this task", "its subtasks"
  if (!mentionedTaskTitle && (lower.includes(' it') || lower.includes('that task') || lower.includes('this task') || lower.includes('to it') || context?.focusedTaskId)) {
    if (context?.lastTaskTitle || context?.focusedTaskTitle) {
      mentionedTaskTitle = context.focusedTaskTitle || context.lastTaskTitle || null;
      targetTaskId = context.focusedTaskId || context.lastTaskId || null;
    }
  }

  // Robust Explicit Task Tag Extraction (handles both quoted `@task:"..."` and single-word `@task:...`)
  const quotedTaskMatch = prompt.match(/@task(?::|\s+)["']([^"'\n\r]+)["']/i);
  if (quotedTaskMatch) {
    mentionedTaskTitle = quotedTaskMatch[1].trim();
  } else {
    const unquotedTaskMatch = prompt.match(/@task:(\S+)/i);
    if (unquotedTaskMatch) {
      mentionedTaskTitle = unquotedTaskMatch[1].trim();
    }
  }

  // Robust Project Tag Extraction
  let mentionedProjectName: string | null = null;
  const quotedProjMatch = prompt.match(/@project(?::|\s+)["']([^"'\n\r]+)["']/i);
  if (quotedProjMatch) {
    mentionedProjectName = quotedProjMatch[1].trim();
  } else {
    const unquotedProjMatch = prompt.match(/@project:(\S+)/i);
    if (unquotedProjMatch) {
      mentionedProjectName = unquotedProjMatch[1].trim();
    }
  }

  // Extract the command text outside of @task / @project tags
  const commandText = prompt
    .replace(/@task(?::|\s+)["'][^"'\n\r]+["']/gi, '')
    .replace(/@task:\S+/gi, '')
    .replace(/@project(?::|\s+)["'][^"'\n\r]+["']/gi, '')
    .replace(/@project:\S+/gi, '')
    .toLowerCase()
    .trim();

  // Detect if user is creating a task vs subtask/note/project
  const isTaskCreatePrefix =
    commandText.startsWith('add task') ||
    commandText.startsWith('create task') ||
    commandText.startsWith('schedule task') ||
    commandText.startsWith('new task') ||
    ((commandText.startsWith('add ') || commandText.startsWith('create ') || commandText.startsWith('schedule ')) &&
      !commandText.startsWith('add subtask') &&
      !commandText.startsWith('add note') &&
      !commandText.startsWith('add permanent note') &&
      !commandText.startsWith('add steps') &&
      !commandText.startsWith('create project') &&
      !commandText.startsWith('add project'));

  const isCreatePrefix = isTaskCreatePrefix;

  const isQuestionOrInfo =
    !isCreatePrefix &&
    !Boolean(context?.focusedTaskId) &&
    (/\b(when|what|status|show|tell|info|details|list|how|who|which|view|report|progress)\b/i.test(commandText) ||
      commandText === 'deadline' ||
      commandText === 'daedline' ||
      commandText.length === 0);

  // Subtask Intent for adding subtask to existing/focused task
  const isSubtaskIntent =
    !isQuestionOrInfo &&
    !isTaskCreatePrefix &&
    (/\b(add\s+subtask|subtask|subtasks|sub-task|sub-tasks|add\s+steps|break\s+down)\b/i.test(commandText) ||
      Boolean(prompt.match(/^(?:with\s+subtasks|subtasks|steps)[:\s]+/i)));

  // Note Intent for attaching note to existing/focused task
  const isNoteIntent =
    !isQuestionOrInfo &&
    !isTaskCreatePrefix &&
    (/\b(add\s+note|add\s+permanent\s+note|attach\s+note)\b/i.test(commandText) ||
      /^(?:note|notes|memo)[:\s]/i.test(commandText));

  // Detect Action/CRUD Keywords with Typo-Tolerance:
  const isDeleteIntent = !isQuestionOrInfo && !isCreatePrefix && /\b(delete|del|delte|remove|drop|trash)\b/i.test(commandText);
  
  const isRescheduleOrDate =
    Boolean(parseFuzzyDate(commandText, todayDate)) &&
    (/\b(resched|resuedle|reschdule|reshedul|reschedule|postpone|move|shift|delay|set\s+due|due|to)\b/i.test(commandText) ||
      Boolean(context?.focusedTaskId));

  const isUpdateIntent =
    !isQuestionOrInfo &&
    !isCreatePrefix &&
    (isRescheduleOrDate ||
      /\b(update|updtae|updte|change|set|make|reschedule|resuedle|reschdule|postpone|move|mark|urgent|critical|high|medium|low)\b/i.test(
        commandText
      ));

  const isCompleteIntent =
    !isQuestionOrInfo &&
    !isCreatePrefix &&
    /\b(complete|complated|completed|complet|finished|finish|done|closed|i completed)\b/i.test(commandText);

  const isCreateIntent =
    !isQuestionOrInfo &&
    (isCreatePrefix ||
      (!mentionedTaskTitle &&
        !targetTaskId &&
        !isSubtaskIntent &&
        !isNoteIntent &&
        !isUpdateIntent &&
        !isCompleteIntent &&
        !isDeleteIntent &&
        !commandText.includes('show') &&
        !commandText.includes('list')));

  // 1. ACTION: ADD NOTE TO TASK
  if (isNoteIntent) {
    let noteContent = prompt
      .replace(/^(add\s+note|note|add\s+permanent\s+note)[:\s]*/i, '')
      .replace(/@\w+(?::"[^"]+"|\S+)?/g, '')
      .replace(/\b(to\s+it|to\s+that\s+task|on\s+it)\b/gi, '')
      .trim();
    if (!noteContent) noteContent = 'Important update';

    const proposals: ProposalItem[] = [
      {
        id: `prop-note-${Date.now()}`,
        type: 'ADD_NOTE',
        title: `Attach Note to "${mentionedTaskTitle || 'Focused Task'}"`,
        noteContent,
        targetTaskId: targetTaskId || undefined,
        targetTaskTitle: mentionedTaskTitle || undefined,
      },
    ];

    return {
      isAction: true,
      sql: mentionedTaskTitle
        ? 'SELECT * FROM tasks WHERE user_id = $1 AND LOWER(title) LIKE LOWER($2) LIMIT 1'
        : 'SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      params: mentionedTaskTitle ? [`%${mentionedTaskTitle}%`] : [],
      proposals,
      focusedTaskId: targetTaskId || undefined,
      focusedTaskTitle: mentionedTaskTitle || undefined,
    };
  }

  // 2. ACTION: ADD SUBTASK TO TASK
  if (isSubtaskIntent) {
    // Check if user is marking subtask complete
    if (lower.includes('complete') || lower.includes('done') || lower.includes('finish') || lower.includes('check')) {
      const proposals: ProposalItem[] = [
        {
          id: `prop-sub-done-${Date.now()}`,
          type: 'UPDATE_TASK',
          title: `Mark Subtask in "${mentionedTaskTitle || 'Focused Task'}" as Complete`,
          targetTaskId: targetTaskId || undefined,
          targetTaskTitle: mentionedTaskTitle || undefined,
        },
      ];

      return {
        isAction: true,
        sql: 'SELECT * FROM subtasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
        params: [],
        proposals,
        focusedTaskId: targetTaskId || undefined,
        focusedTaskTitle: mentionedTaskTitle || undefined,
      };
    }

    // Add new subtask
    let subtaskTitle = prompt
      .replace(/^(add\s+subtask|add\s+another\s+subtask|subtask)[:\s]*/i, '')
      .replace(/@\w+(?::"[^"]+"|\S+)?/g, '')
      .replace(/\b(to\s+it|to\s+that\s+task|under\s+it)\b/gi, '')
      .trim();
    if (!subtaskTitle) subtaskTitle = 'New Subtask';

    const proposals: ProposalItem[] = [
      {
        id: `prop-sub-${Date.now()}`,
        type: 'ADD_SUBTASK',
        title: `Add Subtask "${subtaskTitle}" to "${mentionedTaskTitle || 'Focused Task'}"`,
        subtaskTitle,
        targetTaskId: targetTaskId || undefined,
        targetTaskTitle: mentionedTaskTitle || undefined,
      },
    ];

    return {
      isAction: true,
      sql: mentionedTaskTitle
        ? 'SELECT * FROM tasks WHERE user_id = $1 AND LOWER(title) LIKE LOWER($2) LIMIT 1'
        : 'SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      params: mentionedTaskTitle ? [`%${mentionedTaskTitle}%`] : [],
      proposals,
      focusedTaskId: targetTaskId || undefined,
      focusedTaskTitle: mentionedTaskTitle || undefined,
    };
  }

  // 3. ACTION: DELETE TASK (Requires Safety Confirmation)
  if (isDeleteIntent) {
    const proposals: ProposalItem[] = [
      {
        id: `prop-del-${Date.now()}`,
        type: 'DELETE_TASK',
        title: mentionedTaskTitle ? `Permanently Delete Task "${mentionedTaskTitle}"` : 'Delete Target Task',
        targetTaskId: targetTaskId || undefined,
        targetTaskTitle: mentionedTaskTitle || undefined,
        requiresConfirmation: true,
      },
    ];

    if (mentionedTaskTitle) {
      return {
        isAction: true,
        sql: 'SELECT * FROM tasks WHERE user_id = $1 AND LOWER(title) LIKE LOWER($2) ORDER BY due_date ASC NULLS LAST, created_at DESC',
        params: [`%${mentionedTaskTitle}%`],
        proposals,
        actionType: 'CONFIRM_DELETION',
        focusedTaskId: targetTaskId || undefined,
        focusedTaskTitle: mentionedTaskTitle || undefined,
      };
    }

    return {
      isAction: true,
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND status = 'Completed' ORDER BY created_at DESC",
      params: [],
      proposals,
      actionType: 'CONFIRM_DELETION',
    };
  }

  // 4. CRUD: UPDATE & COMPLETE ACTIONS (e.g. "resuedle to tommorw", "mark @task:for done", "make @task:for urgent", "move it to Friday")
  if (isUpdateIntent || isCompleteIntent) {
    const proposals: ProposalItem[] = [];

    let newStatus: 'Todo' | 'In Progress' | 'Completed' | undefined = undefined;
    if (isCompleteIntent || lower.includes('complete') || lower.includes('complated') || lower.includes('done') || lower.includes('finished')) {
      newStatus = 'Completed';
    } else if (lower.includes('in progress') || lower.includes('progress') || lower.includes('working')) {
      newStatus = 'In Progress';
    } else if (lower.includes('todo') || lower.includes('to do') || lower.includes('reopen')) {
      newStatus = 'Todo';
    }

    let newPriority: 'Low' | 'Medium' | 'High' | 'Urgent' | 'Critical' | undefined = undefined;
    if (lower.includes('critical')) newPriority = 'Critical';
    else if (lower.includes('urgent') || lower.includes('@urgent')) newPriority = 'Urgent';
    else if (lower.includes('high') || lower.includes('@high')) newPriority = 'High';
    else if (lower.includes('medium') || lower.includes('@medium')) newPriority = 'Medium';
    else if (lower.includes('low') || lower.includes('@low')) newPriority = 'Low';

    const newDueDate = parseFuzzyDate(prompt, todayDate) || undefined;

    const actionType = newStatus === 'Completed' ? 'COMPLETE_TASK' : 'UPDATE_TASK';
    const actionLabel =
      newStatus === 'Completed'
        ? `Mark task ${mentionedTaskTitle ? `"${mentionedTaskTitle}"` : ''} as Completed`
        : newDueDate && !newStatus && !newPriority
        ? `Reschedule task ${mentionedTaskTitle ? `"${mentionedTaskTitle}"` : ''} to ${newDueDate}`
        : `Update task ${mentionedTaskTitle ? `"${mentionedTaskTitle}"` : ''}${newPriority ? ` to [${newPriority}] priority` : ''}${newDueDate ? ` (Due: ${newDueDate})` : ''}${newStatus ? ` (Status: ${newStatus})` : ''}`;

    proposals.push({
      id: `prop-upd-${Date.now()}`,
      type: actionType,
      title: actionLabel.trim(),
      status: newStatus,
      priority: newPriority,
      dueDate: newDueDate,
      targetTaskId: targetTaskId || undefined,
      targetTaskTitle: mentionedTaskTitle || undefined,
    });

    if (mentionedTaskTitle || targetTaskId) {
      return {
        isAction: true,
        sql: targetTaskId
          ? 'SELECT * FROM tasks WHERE user_id = $1 AND id = $2'
          : 'SELECT * FROM tasks WHERE user_id = $1 AND LOWER(title) LIKE LOWER($2) ORDER BY due_date ASC NULLS LAST, created_at DESC',
        params: targetTaskId ? [targetTaskId] : [`%${mentionedTaskTitle}%`],
        proposals,
        focusedTaskId: targetTaskId || undefined,
        focusedTaskTitle: mentionedTaskTitle || undefined,
      };
    }

    return {
      isAction: true,
      sql: 'SELECT * FROM tasks WHERE user_id = $1 ORDER BY due_date ASC NULLS LAST, created_at DESC',
      params: [],
      proposals,
    };
  }

  // 5. CRUD: CREATE ACTION (e.g. "add task Deploy to production due tomorrow with subtasks: DB migration, Smoke tests")
  if (isCreateIntent) {
    const proposals: ProposalItem[] = [];
    let priority: 'Low' | 'Medium' | 'High' | 'Urgent' | 'Critical' = 'Medium';
    if (lower.includes('critical')) priority = 'Critical';
    else if (lower.includes('urgent') || lower.includes('@urgent')) priority = 'Urgent';
    else if (lower.includes('high') || lower.includes('@high')) priority = 'High';
    else if (lower.includes('low') || lower.includes('@low')) priority = 'Low';

    let dueDate = todayDate;
    if (lower.includes('tomorrow')) {
      dueDate = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    } else if (lower.includes('next week')) {
      dueDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    }
    const dateMatch = prompt.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (dateMatch) dueDate = dateMatch[1];

    // Extract due time if mentioned e.g. "at 4pm", "at 16:00", "4:30 pm"
    let dueTime: string | undefined = undefined;
    const timeMatch = prompt.match(/\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})\b/i);
    if (timeMatch) dueTime = timeMatch[1].trim();

    // Extract subtasks if mentioned e.g. "with subtasks: A, B, C" or "steps: A, B"
    let subtasks: string[] | undefined = undefined;
    const subtasksMatch = prompt.match(/(?:with\s+subtasks|subtasks|steps)[:\s]+([^;.\n]+)/i);
    if (subtasksMatch) {
      subtasks = subtasksMatch[1]
        .split(/[,&]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // Extract category if mentioned e.g. "category: Engineering"
    let category: string | undefined = undefined;
    const catMatch = prompt.match(/(?:category|cat)[:\s]+([a-zA-Z0-9_-]+)/i);
    if (catMatch) category = catMatch[1].trim();

    // Extract tags e.g. "#backend #v2"
    let tags: string | undefined = undefined;
    const tagMatches = prompt.match(/#[a-zA-Z0-9_-]+/g);
    if (tagMatches) tags = tagMatches.join(', ');

    // Extract permanent note if mentioned e.g. "note: Check latency"
    let notes: string | undefined = undefined;
    const noteMatch = prompt.match(/(?:note|notes)[:\s]+([^;.\n]+)/i);
    if (noteMatch) notes = noteMatch[1].trim();

    // Extract description
    let description: string | undefined = undefined;
    const descMatch = prompt.match(/(?:desc|description)[:\s]+([^;.\n]+)/i);
    if (descMatch) description = descMatch[1].trim();

    let cleanTitle = prompt
      .replace(/^(add\s+task|create\s+task|add|create|new\s+task|schedule)\s+/i, '')
      .replace(/(?:with\s+subtasks|subtasks|steps)[:\s]+[^;.\n]+/gi, '')
      .replace(/(?:category|cat)[:\s]+[a-zA-Z0-9_-]+/gi, '')
      .replace(/(?:note|notes)[:\s]+[^;.\n]+/gi, '')
      .replace(/(?:desc|description)[:\s]+[^;.\n]+/gi, '')
      .replace(/#[a-zA-Z0-9_-]+/g, '')
      .replace(/@\w+(?::"[^"]+"|\S+)?/g, '')
      .replace(/\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})\b/gi, '')
      .replace(/\b(urgent|high|medium|low|critical|priority|due|today|tomorrow|next\s+week)\b/gi, '')
      .trim();
    if (!cleanTitle) cleanTitle = 'New Task';

    proposals.push({
      id: `prop-create-${Date.now()}`,
      type: 'CREATE_TASK',
      title: cleanTitle,
      description,
      priority,
      dueDate,
      dueTime,
      status: 'Todo',
      category,
      tags,
      isImportant: priority === 'Urgent' || priority === 'Critical',
      subtasks,
      notes,
    });

    return {
      isAction: true,
      sql: 'SELECT * FROM tasks WHERE user_id = $1 ORDER BY due_date ASC NULLS LAST, created_at DESC',
      params: [],
      proposals,
    };
  }

  // 6. READ: Important Work / Important Tasks
  if (lower.includes('important') || lower.includes('@important') || lower.includes('priority tasks')) {
    return {
      isAction: false,
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND (is_important = true OR priority = 'Urgent' OR priority = 'High' OR priority = 'Critical') AND status != 'Completed' ORDER BY due_date ASC NULLS LAST, priority DESC",
      params: [],
    };
  }

  // 7. READ: Tomorrow's tasks
  if (lower.includes('tomorrow')) {
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    return {
      isAction: false,
      sql: 'SELECT * FROM tasks WHERE user_id = $1 AND due_date = $2 ORDER BY priority DESC, created_at DESC',
      params: [tomorrowStr],
    };
  }

  // 8. READ: All Projects & Project Deadlines Query (e.g. "tell deadline of all project", "show all projects")
  const isProjectQuery =
    (lower.includes('project') || lower.includes('projects')) &&
    (lower.includes('all') ||
      lower.includes('deadline') ||
      lower.includes('daedline') ||
      lower.includes('list') ||
      lower.includes('show') ||
      lower.includes('what') ||
      lower.includes('tell') ||
      lower.includes('progress')) &&
    !mentionedTaskTitle;

  if (isProjectQuery) {
    return {
      isAction: false,
      targetEntity: 'PROJECTS',
      sql: `SELECT p.*, COUNT(t.id) as task_count, COUNT(CASE WHEN t.status = 'Completed' THEN 1 END) as completed_task_count FROM projects p LEFT JOIN tasks t ON p.id = t.project_id WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.deadline ASC NULLS LAST, p.name ASC`,
      params: [],
    };
  }

  // 9. READ: Specific Project filter (e.g. "Show SalesForge progress")
  if (mentionedProjectName || (lower.includes('progress') && !mentionedTaskTitle)) {
    const projSearch = mentionedProjectName || prompt.replace(/show|progress|of|project/gi, '').trim();
    return {
      isAction: false,
      sql: `SELECT t.*, p.name as project_name, p.status as project_status, p.deadline as project_deadline FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.user_id = $1 AND LOWER(p.name) LIKE LOWER($2) ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC`,
      params: [`%${projSearch}%`],
    };
  }

  // 6. READ: Specific Individual Task Mention filter (without mutations)
  if (mentionedTaskTitle) {
    return {
      isAction: false,
      sql: `SELECT * FROM tasks WHERE user_id = $1 AND LOWER(title) LIKE LOWER($2) ORDER BY due_date ASC NULLS LAST, created_at DESC`,
      params: [`%${mentionedTaskTitle}%`],
    };
  }

  // 3. Date Range extraction (e.g. "from 2026-08-10 to 2026-08-16", "between ... and ...")
  const rangeMatch = prompt.match(/(?:from|between)\s+(\d{4}-\d{2}-\d{2})\s+(?:to|and)\s+(\d{4}-\d{2}-\d{2})/i);
  if (rangeMatch) {
    return {
      isAction: false,
      sql: 'SELECT * FROM tasks WHERE user_id = $1 AND due_date >= $2 AND due_date <= $3 ORDER BY due_date ASC NULLS LAST, created_at DESC',
      params: [rangeMatch[1], rangeMatch[2]],
    };
  }

  // 3. This Week filter
  if (lower.includes('this week')) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const firstDay = new Date(now.getTime() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) * 86400000);
    const lastDay = new Date(firstDay.getTime() + 6 * 86400000);
    const startStr = firstDay.toISOString().split('T')[0];
    const endStr = lastDay.toISOString().split('T')[0];

    return {
      isAction: false,
      sql: 'SELECT * FROM tasks WHERE user_id = $1 AND due_date >= $2 AND due_date <= $3 ORDER BY due_date ASC NULLS LAST, created_at DESC',
      params: [startStr, endStr],
    };
  }

  // 6. Urgent & Overdue filter (strict active task scoping)
  if (lower.includes('urgent') || lower.includes('@urgent') || lower.includes('critical') || lower.includes('overdue')) {
    if (lower.includes('urgent') && lower.includes('overdue')) {
      return {
        isAction: false,
        sql: "SELECT * FROM tasks WHERE user_id = $1 AND ((priority = 'Urgent' OR priority = 'High') OR (due_date < $2)) AND status != 'Completed' ORDER BY due_date ASC NULLS LAST, priority DESC",
        params: [todayDate],
      };
    } else if (lower.includes('overdue')) {
      return {
        isAction: false,
        sql: "SELECT * FROM tasks WHERE user_id = $1 AND due_date < $2 AND status != 'Completed' ORDER BY due_date ASC, priority DESC",
        params: [todayDate],
      };
    } else {
      return {
        isAction: false,
        sql: "SELECT * FROM tasks WHERE user_id = $1 AND (priority = 'Urgent' OR priority = 'High') AND status != 'Completed' ORDER BY due_date ASC NULLS LAST, created_at DESC",
        params: [],
      };
    }
  }

  // 7. Due Today filter
  if (lower.includes('today') && !lower.includes('plan') && !lower.includes('agenda')) {
    return {
      isAction: false,
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND due_date = $2 AND status != 'Completed' ORDER BY priority DESC, created_at DESC",
      params: [todayDate],
    };
  }

  // 8. Completed / Done filter
  if (lower.includes('completed') || lower.includes('done') || lower.includes('finished') || lower.includes('@status:completed')) {
    return {
      isAction: false,
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND status = 'Completed' ORDER BY created_at DESC",
      params: [],
    };
  }

  // 9. Pending / Peding / Todo filter
  if (lower.includes('pending') || lower.includes('peding') || lower.includes('todo') || lower.includes('@status:todo')) {
    return {
      isAction: false,
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND status != 'Completed' ORDER BY due_date ASC NULLS LAST, created_at DESC",
      params: [],
    };
  }

  // 10. Default: All Workspace Tasks (for Day Planning, Agenda, General Retrieval)
  return {
    isAction: false,
    sql: 'SELECT * FROM tasks WHERE user_id = $1 ORDER BY due_date ASC NULLS LAST, created_at DESC',
    params: [],
  };
}

/**
 * Agentic Synthesis: Evaluates DB Query Results & Produces the Executive AI Briefing
 */
export function synthesizeAgenticResponse(
  userPrompt: string,
  queriedTasks: TaskRecord[],
  sqlQuery: string,
  todayDate: string,
  existingProposals: ProposalItem[] = []
): AIResponse {
  const lower = userPrompt.toLowerCase().trim();

  const toDateStr = (d: any) => {
    if (!d) return null;
    if (d instanceof Date) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return String(d).split('T')[0];
  };

  const overdueTasks = queriedTasks.filter((t) => {
    const dStr = toDateStr(t.due_date);
    return dStr && dStr < todayDate && t.status !== 'Completed';
  });
  const todayTasks = queriedTasks.filter((t) => toDateStr(t.due_date) === todayDate && t.status !== 'Completed');
  const upcomingTasks = queriedTasks.filter((t) => {
    const dStr = toDateStr(t.due_date);
    return (!dStr || dStr > todayDate) && t.status !== 'Completed';
  });
  const completedTasks = queriedTasks.filter((t) => t.status === 'Completed');
  const pendingTasks = queriedTasks.filter((t) => t.status !== 'Completed');

  const proposals: ProposalItem[] = [...existingProposals];

  // If this is a Plan request, run full Agentic Daily Plan synthesis
  const isPlanQuery = lower.includes('plan') || lower.includes('agenda') || lower.includes('@today');

  if (isPlanQuery) {
    // Propose rescheduling overdue tasks to today
    overdueTasks.forEach((ot, idx) => {
      proposals.push({
        id: `prop-reschedule-${idx}-${Date.now()}`,
        type: 'UPDATE_TASK',
        title: `Reschedule "${ot.title}" to Today`,
        dueDate: todayDate,
        priority: 'Urgent',
        status: 'Todo',
        targetTaskId: ot.id,
      });
    });

    let msg = `### J.A.R.V.I.S Autonomous Daily Plan Protocol\n`;
    msg += `Good day, Sir. Retrieved **${queriedTasks.length} tasks** directly from database.\n\n`;

    msg += `**Executive Strategy & Workload Assessment**:\n`;
    if (overdueTasks.length > 0) {
      msg += `- **Attention Required**: ${overdueTasks.length} overdue task(s) require immediate remediation.\n`;
    }
    msg += `- **Today's Active Load**: ${todayTasks.length} scheduled item(s).\n`;
    msg += `- **Pipeline Backlog**: ${upcomingTasks.length} queued task(s).\n\n`;

    msg += `**Chronological Execution Timeline**:\n`;
    if (overdueTasks.length > 0 || todayTasks.some((t) => t.priority === 'Urgent' || t.priority === 'High')) {
      const critical = [...overdueTasks, ...todayTasks.filter((t) => t.priority === 'Urgent' || t.priority === 'High')];
      msg += `- **09:00 – 11:30 | Critical Deep Work Block**\n  Focus: ${critical.map((t) => t.title).slice(0, 3).join(', ')}\n`;
    }
    msg += `- **11:45 – 14:00 | Core Deliverables Block**\n  Execution of standard priority items & team syncs.\n`;
    msg += `- **14:30 – 17:00 | Tactical Reviews & Pipeline Tasks**\n  Advancing upcoming sprint deliverables.\n`;
    msg += `- **17:00 – 18:00 | Wrap-up & Tomorrow Staging**\n  Review checklist completions & stage tomorrow's priorities.\n\n`;

    msg += `**Master Task Checklist**:\n`;
    if (overdueTasks.length > 0) {
      msg += `Overdue Tasks (${overdueTasks.length}):\n` +
        overdueTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Due: ${toDateStr(t.due_date)} - OVERDUE)`).join('\n') + '\n\n';
    }
    if (todayTasks.length > 0) {
      msg += `Due Today (${todayTasks.length}):\n` +
        todayTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Due: ${toDateStr(t.due_date) || todayDate}) • Status: ${t.status}`).join('\n') + '\n\n';
    }
    if (upcomingTasks.length > 0) {
      msg += `Upcoming & Backlog (${upcomingTasks.length}):\n` +
        upcomingTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Due: ${toDateStr(t.due_date) || 'No deadline'}) • Status: ${t.status}`).join('\n') + '\n\n';
    }
    if (completedTasks.length > 0) {
      msg += `Recently Completed (${completedTasks.length}):\n` +
        completedTasks.map((t) => `- [x] ~${t.title}~ • [${t.priority}] (Due: ${toDateStr(t.due_date) || 'Done'})`).join('\n') + '\n\n';
    }
    if (queriedTasks.length === 0) {
      msg += `You currently have 0 tasks in your workspace.`;
    }

    return {
      message: msg.trim(),
      actionType: proposals.length > 0 ? 'PROPOSAL' : 'READ_ONLY',
      proposals,
      sqlQuery,
    };
  }

  // If this is a focused query (Pending / Completed / Date Range / Urgent / Single Task / Projects)
  let msg = `### J.A.R.V.I.S Database Query Results\n`;

  // Projects Overview Query (e.g. "tell deadline of all project", "all projects", "show projects")
  const isProjectList =
    (lower.includes('project') || lower.includes('projects')) &&
    (lower.includes('all') ||
      lower.includes('deadline') ||
      lower.includes('daedline') ||
      lower.includes('list') ||
      lower.includes('show') ||
      lower.includes('what') ||
      lower.includes('tell'));

  if (isProjectList) {
    let pMsg = `### J.A.R.V.I.S Projects & Deadlines Overview\n`;
    pMsg += `Found **${queriedTasks.length} project(s)** in your workspace.\n\n`;

    if (queriedTasks.length === 0) {
      pMsg += `You currently have 0 projects in your workspace. You can create projects from the Dashboard or ask JARVIS to add a new project.`;
    } else {
      queriedTasks.forEach((p: any) => {
        const dStr = toDateStr(p.deadline || p.due_date);
        const isOverdue = dStr && dStr < todayDate && p.status !== 'Completed';
        const clientInfo = p.client ? ` • Client: ${p.client}` : '';
        const progressInfo = p.task_count ? ` • Tasks: ${p.completed_task_count || 0}/${p.task_count} done` : '';
        const deadlineLabel = dStr ? `**${dStr}**${isOverdue ? ' (OVERDUE)' : ''}` : 'No deadline assigned';

        pMsg += `- **${p.name || p.title}**${clientInfo}\n`;
        pMsg += `  Deadline: ${deadlineLabel} • Status: ${p.status || 'Active'}${progressInfo}\n\n`;
      });
    }

    return {
      message: pMsg.trim(),
      actionType: 'READ_ONLY',
      proposals: [],
      sqlQuery,
    };
  }

  msg += `Found **${queriedTasks.length} task(s)** matching your query criteria.\n\n`;

  // Specific Task Deadline / Detail Query
  if (
    queriedTasks.length === 1 &&
    (lower.includes('deadline') ||
      lower.includes('daedline') ||
      lower.includes('when') ||
      lower.includes('due') ||
      lower.includes('info') ||
      lower.includes('status'))
  ) {
    const t = queriedTasks[0];
    const dStr = toDateStr(t.due_date);
    const isOverdue = dStr && dStr < todayDate && t.status !== 'Completed';
    msg += `**Task Details & Deadline Overview**:\n`;
    msg += `- **Title**: ${t.title}\n`;
    msg += `- **Deadline / Due Date**: ${dStr ? `**${dStr}**` : 'No deadline assigned'}${isOverdue ? ' (OVERDUE)' : ''}\n`;
    msg += `- **Priority**: [${t.priority}]\n`;
    msg += `- **Current Status**: ${t.status}\n`;
    return {
      message: msg.trim(),
      actionType: 'READ_ONLY',
      proposals: [],
      sqlQuery,
    };
  }

  const isPendingFilter = lower.includes('pending') || lower.includes('peding') || lower.includes('todo');
  const isCompletedFilter = lower.includes('completed') || lower.includes('done') || lower.includes('finished');

  if (isPendingFilter) {
    if (pendingTasks.length === 0) {
      msg += `All caught up! You have 0 pending tasks.`;
    } else {
      msg += `Pending Tasks (${pendingTasks.length}):\n` +
        pendingTasks
          .map((t) => {
            const dStr = toDateStr(t.due_date);
            const isOverdue = dStr && dStr < todayDate;
            const dueLabel = dStr ? `(Due: ${dStr}${isOverdue ? ' - OVERDUE' : ''})` : '(No deadline)';
            return `- [ ] **${t.title}** • [${t.priority}] ${dueLabel} • Status: ${t.status}`;
          })
          .join('\n') + '\n\n';
    }
  } else if (isCompletedFilter) {
    if (completedTasks.length === 0) {
      msg += `No completed tasks found in your workspace yet.`;
    } else {
      msg += `Completed Tasks (${completedTasks.length}):\n` +
        completedTasks.map((t) => `- [x] ~${t.title}~ • [${t.priority}] (Due: ${toDateStr(t.due_date) || 'Done'})`).join('\n') + '\n\n';
    }
  } else {
    // Categorized breakdown of queried rows with explicit deadline on all items
    if (overdueTasks.length > 0) {
      msg += `Overdue Tasks (${overdueTasks.length}):\n` +
        overdueTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Due: ${toDateStr(t.due_date)} - OVERDUE) • Status: ${t.status}`).join('\n') + '\n\n';
    }
    if (todayTasks.length > 0) {
      msg += `Due Today (${todayTasks.length}):\n` +
        todayTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Due: ${toDateStr(t.due_date) || todayDate}) • Status: ${t.status}`).join('\n') + '\n\n';
    }
    if (upcomingTasks.length > 0) {
      msg += `Upcoming & Backlog (${upcomingTasks.length}):\n` +
        upcomingTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Due: ${toDateStr(t.due_date) || 'No deadline'}) • Status: ${t.status}`).join('\n') + '\n\n';
    }
    if (completedTasks.length > 0) {
      msg += `Recently Completed (${completedTasks.length}):\n` +
        completedTasks.map((t) => `- [x] ~${t.title}~ • [${t.priority}] (Due: ${toDateStr(t.due_date) || 'Done'})`).join('\n') + '\n\n';
    }
    if (queriedTasks.length === 0) {
      msg += `No matching tasks found in database for the requested criteria.`;
    }
  }

  return {
    message: msg.trim(),
    actionType: proposals.length > 0 ? 'PROPOSAL' : 'READ_ONLY',
    proposals,
    sqlQuery,
  };
}

export async function generateAIChatResponse(
  userPrompt: string,
  userTasks: TaskRecord[],
  userProjects: ProjectRecord[]
): Promise<AIResponse> {
  const todayDate = new Date().toISOString().split('T')[0];
  const sqlGen = generateSQLForUserQuery(userPrompt, todayDate);
  return synthesizeAgenticResponse(userPrompt, userTasks, sqlGen.sql, todayDate, sqlGen.proposals || []);
}
