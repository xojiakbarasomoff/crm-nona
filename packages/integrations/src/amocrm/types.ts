/**
 * Adapter-level types for amoCRM. These are our normalized shapes, not amoCRM's raw API objects.
 */

export interface AmoUser {
  id: string;
  name: string;
  email: string | null;
}

export interface AmoPipeline {
  id: string;
  name: string;
  isMain: boolean;
  statuses: Array<{ id: string; name: string; type: 'won' | 'lost' | 'normal' }>;
}

export interface AmoLeadSnapshot {
  id: string;
  name: string;
  pipelineId: string;
  statusId: string;
  responsibleUserId: string | null;
  price: number | null;
  updatedAt: Date;
  closedAt: Date | null;
  contactIds: string[];
  customFields: Record<string, string>;
  deleted: boolean;
}

export interface AmoContactSnapshot {
  id: string;
  name: string | null;
  phones: string[];
  emails: string[];
  responsibleUserId: string | null;
  updatedAt: Date;
  customFields: Record<string, string>;
  deleted: boolean;
}

export interface CreateLeadInput {
  name: string;
  pipelineId: string;
  statusId: string;
  responsibleUserId: string | null;
  /** Stored in a dedicated custom field so that a timed-out create can be reconciled (TZ §19.2). */
  operationId: string;
  operationFieldId: string | null;
  customFields: Array<{ fieldId: string; value: string }>;
  contact: { existingId: string | null; name: string | null; phone: string | null; email: string | null };
}

export interface CreateTaskInput {
  entityType: 'leads' | 'contacts';
  entityId: string;
  text: string;
  completeTill: Date;
  responsibleUserId: string | null;
  /** Embedded in the task text as "[op:<key>]" for reconciliation. */
  operationKey: string;
}

export interface AmoRestClient {
  readonly descriptor: { name: string; kind: 'mock' | 'live' };
  getAccount(): Promise<{ id: string; subdomain: string }>;
  listUsers(): Promise<AmoUser[]>;
  listPipelines(): Promise<AmoPipeline[]>;
  getLead(id: string): Promise<AmoLeadSnapshot | null>;
  getContact(id: string): Promise<AmoContactSnapshot | null>;
  listLeadsUpdatedSince(since: Date, page: number, limit: number): Promise<{ items: AmoLeadSnapshot[]; hasMore: boolean }>;
  listContactsUpdatedSince(since: Date, page: number, limit: number): Promise<{ items: AmoContactSnapshot[]; hasMore: boolean }>;
  createLeadWithContact(input: CreateLeadInput): Promise<{ leadId: string; contactId: string }>;
  findLeadByOperationId(operationId: string): Promise<{ leadId: string; contactId: string | null } | null>;
  updateLead(id: string, patch: { statusId?: string; pipelineId?: string; responsibleUserId?: string; price?: number; customFields?: Array<{ fieldId: string; value: string }> }): Promise<{ updatedAt: Date }>;
  createTask(input: CreateTaskInput): Promise<{ taskId: string }>;
  findTaskByOperationKey(entityType: 'leads' | 'contacts', entityId: string, operationKey: string): Promise<{ taskId: string } | null>;
  completeTask(taskId: string, resultText: string): Promise<void>;
  updateTaskResponsible(taskId: string, responsibleUserId: string): Promise<void>;
  addNote(entityType: 'leads' | 'contacts', entityId: string, text: string): Promise<void>;
  createPipelineStatus(pipelineId: string, name: string): Promise<{ id: string }>;
  listCustomFields(entity: 'leads' | 'contacts'): Promise<Array<{ id: string; name: string; code: string | null; type: string }>>;
  createCustomField(entity: 'leads' | 'contacts', field: { name: string; type: string; code: string }): Promise<{ id: string }>;
}

export const opMarker = (key: string) => `[op:${key}]`;
