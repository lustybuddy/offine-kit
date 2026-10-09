import React, { useState, useEffect } from 'react';
import {
  Search,
  Filter,
  Plus,
  LayoutGrid,
  List,
  CheckCircle2,
  Clock,
  PlayCircle,
  Eye,
  Sparkles,
  UserCheck,
  CloudOff,
  RefreshCw,
  AlertTriangle,
  WifiOff,
} from 'lucide-react';
import TaskCard from './TaskCard';
import ConflictModal from './ConflictModal';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { useSync } from '../../context/SyncContext';
import offlineStorage from '../../services/offlineStorage';

const COLUMNS = [
  { id: 'todo', title: 'To Do', icon: Clock, color: '#94a3b8' },
  { id: 'in-progress', title: 'In Progress', icon: PlayCircle, color: '#6366f1' },
  { id: 'in-review', title: 'In Review', icon: Eye, color: '#f59e0b' },
  { id: 'done', title: 'Done', icon: CheckCircle2, color: '#10b981' },
];

const KanbanBoard = ({
  project,
  onSelectTask,
  onOpenCreateTaskModal,
}) => {
  const { user } = useAuth();
  const { socket, joinProject, leaveProject } = useSocket();
  const {
    isOnline,
    isSyncing,
    pendingCount,
    conflictsCount,
    enqueueAction,
    processSyncQueue,
    registerSyncListener,
    reloadState,
  } = useSync();

  const [tasks, setTasks] = useState(() => {
    return project?._id ? offlineStorage.getStoredTasks(project._id) : [];
  });
  const [loading, setLoading] = useState(false);
  const [draggedTask, setDraggedTask] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);
  const [showConflictModal, setShowConflictModal] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [viewMode, setViewMode] = useState('kanban'); // 'kanban' or 'list'

  const canCreateTask = user?.role === 'admin' || user?.role === 'manager';

  // Fetch tasks with offline caching support
  const fetchTasks = async () => {
    if (!project?._id) return;

    // Load instantly from cache
    const cached = offlineStorage.getStoredTasks(project._id);
    if (cached && cached.length > 0) {
      setTasks(cached);
    } else {
      setLoading(true);
    }

    if (!navigator.onLine) {
      setLoading(false);
      return;
    }

    try {
      const res = await api.get(`/projects/${project._id}/tasks`, {
        params: {
          search: search || undefined,
          priority: priorityFilter !== 'all' ? priorityFilter : undefined,
          assignee: assigneeFilter !== 'all' ? assigneeFilter : undefined,
        },
      });
      if (res.data.success) {
        // Merge server tasks with any unsynced local creations
        const queue = offlineStorage.getSyncQueue();
        const pendingCreated = queue
          .filter((q) => q.type === 'CREATE_TASK' && q.projectId === project._id)
          .map((q) => ({
            _id: q.tempId,
            ...q.payload,
            creator: user,
            project: project._id,
            createdAt: new Date(q.timestamp).toISOString(),
            updatedAt: new Date(q.timestamp).toISOString(),
            _isOffline: true,
            _syncPending: true,
          }));

        const serverTasks = res.data.data;
        const combined = [...serverTasks];
        pendingCreated.forEach((pt) => {
          if (!combined.some((t) => t._id === pt._id)) {
            combined.push(pt);
          }
        });

        setTasks(combined);
        offlineStorage.saveStoredTasks(project._id, combined);
      }
    } catch (err) {
      console.warn('Network error loading tasks; using offline cache:', err);
      const fallback = offlineStorage.getStoredTasks(project._id);
      if (fallback && fallback.length > 0) {
        setTasks(fallback);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, [project?._id, search, priorityFilter, assigneeFilter]);

  // Sync listener: updates UI live when offline changes sync with server
  useEffect(() => {
    const unregister = registerSyncListener((event) => {
      if (event.type === 'TASK_CREATED_SYNCED') {
        setTasks((prev) =>
          prev.map((t) => (t._id === event.tempId ? event.task : t))
        );
      } else if (event.type === 'TASK_STATUS_SYNCED' || event.type === 'TASK_UPDATED_SYNCED') {
        setTasks((prev) =>
          prev.map((t) =>
            t._id === event.taskId ? { ...t, ...event.task, _syncPending: false } : t
          )
        );
      } else if (event.type === 'TASK_DELETED_SYNCED') {
        setTasks((prev) => prev.filter((t) => t._id !== event.taskId));
      } else if (event.type === 'CONFLICT_RESOLVED_KEEP_SERVER') {
        setTasks((prev) =>
          prev.map((t) => (t._id === event.taskId ? event.task : t))
        );
      }
    });

    return () => unregister();
  }, [registerSyncListener]);

  // Real-time socket events setup
  useEffect(() => {
    if (!project?._id || !socket) return;

    joinProject(project._id);

    // Live task moved / status changed
    socket.on('task:status_changed', ({ taskId, newStatus, task }) => {
      setTasks((prev) =>
        prev.map((t) => (t._id === taskId ? { ...t, status: newStatus } : t))
      );
    });

    // Live task created
    socket.on('task:created', (newTask) => {
      setTasks((prev) => {
        if (prev.some((t) => t._id === newTask._id)) return prev;
        return [...prev, newTask];
      });
    });

    // Live task updated
    socket.on('task:updated', (updatedTask) => {
      setTasks((prev) =>
        prev.map((t) => (t._id === updatedTask._id ? updatedTask : t))
      );
    });

    // Live task deleted
    socket.on('task:deleted', ({ taskId }) => {
      setTasks((prev) => prev.filter((t) => t._id !== taskId));
    });

    return () => {
      leaveProject(project._id);
      socket.off('task:status_changed');
      socket.off('task:created');
      socket.off('task:updated');
      socket.off('task:deleted');
    };
  }, [project?._id, socket]);

  // Drag and drop handlers
  const handleDragStart = (e, task) => {
    setDraggedTask(task);
    e.dataTransfer.setData('text/plain', task._id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggedTask(null);
    setDragOverColumn(null);
  };

  const handleDragOver = (e, columnId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverColumn !== columnId) {
      setDragOverColumn(columnId);
    }
  };

  const handleDragLeave = (e, columnId) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    if (dragOverColumn === columnId) {
      setDragOverColumn(null);
    }
  };

  const handleDrop = async (e, targetStatus) => {
    e.preventDefault();
    setDragOverColumn(null);
    const taskId = e.dataTransfer.getData('text/plain');

    if (!taskId || !draggedTask || draggedTask.status === targetStatus) return;

    // RBAC check: Members can only move tasks assigned to them
    if (user?.role === 'member') {
      const isAssigned =
        draggedTask.assignee &&
        (draggedTask.assignee._id === user._id || draggedTask.assignee === user._id);
      if (!isAssigned) {
        alert('Permission Denied: Members can only update tasks assigned to them.');
        return;
      }
    }

    const previousStatus = draggedTask.status;
    const lastKnownUpdatedAt = draggedTask.updatedAt || new Date().toISOString();

    // Optimistic UI update
    const updatedTasks = tasks.map((t) =>
      t._id === taskId
        ? { ...t, status: targetStatus, _syncPending: !navigator.onLine }
        : t
    );
    setTasks(updatedTasks);
    offlineStorage.saveStoredTasks(project._id, updatedTasks);

    if (!navigator.onLine) {
      // Queue move action locally
      enqueueAction({
        type: 'MOVE_TASK',
        projectId: project._id,
        taskId,
        taskTitle: draggedTask.title,
        payload: { status: targetStatus },
        lastKnownUpdatedAt,
      });
      return;
    }

    // Online: attempt immediate patch
    try {
      const res = await api.patch(`/tasks/${taskId}/status`, {
        status: targetStatus,
        lastKnownUpdatedAt,
      });
      if (res.data.success) {
        setTasks((prev) =>
          prev.map((t) => (t._id === taskId ? { ...t, ...res.data.data, _syncPending: false } : t))
        );
      }
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.conflict) {
        reloadState();
        alert(`Conflict: Task "${draggedTask.title}" was updated on server. Please resolve in the banner.`);
        fetchTasks();
      } else if (!err.response || err.code === 'ERR_NETWORK') {
        console.warn('Network dropped during status update; queuing offline action.');
        enqueueAction({
          type: 'MOVE_TASK',
          projectId: project._id,
          taskId,
          taskTitle: draggedTask.title,
          payload: { status: targetStatus },
          lastKnownUpdatedAt,
        });
      } else {
        console.error('Failed to update task status:', err);
        setTasks((prev) =>
          prev.map((t) => (t._id === taskId ? { ...t, status: previousStatus } : t))
        );
      }
    }
  };

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center text-slate-400">
          <p>Please select a project from the sidebar to view its board.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-61px)] overflow-hidden bg-slate-950/40">
      {/* Top Header & Filter Toolbar */}
      <div className="p-6 pb-4 border-b border-slate-800/80 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span
                className="w-3.5 h-3.5 rounded-full shadow-md"
                style={{ backgroundColor: project.color || '#6366f1' }}
              ></span>
              <h2 className="text-xl font-bold tracking-tight text-white">
                {project.name}
              </h2>
              <span className="text-xs px-2 py-0.5 rounded-md bg-slate-800 text-slate-400 font-mono border border-slate-700/60">
                {project.key}
              </span>
            </div>
            {project.description && (
              <p className="text-xs text-slate-400 mt-1 max-w-2xl line-clamp-1">
                {project.description}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2.5">
            {/* View Switcher */}
            <div className="flex items-center p-1 rounded-xl bg-slate-900 border border-slate-800">
              <button
                onClick={() => setViewMode('kanban')}
                className={`p-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
                  viewMode === 'kanban'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="Kanban Board View"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
                  viewMode === 'list'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="List / Table View"
              >
                <List className="w-4 h-4" />
              </button>
            </div>

            {/* Create Task button */}
            {canCreateTask && (
              <button
                onClick={onOpenCreateTaskModal}
                className="btn-primary text-xs py-2 px-3.5"
              >
                <Plus className="w-4 h-4" />
                <span>Create Task</span>
              </button>
            )}
          </div>
        </div>

        {/* Filters Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-3 flex-1 min-w-[240px] max-w-md">
            <div className="relative w-full">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search tasks, descriptions, or tags..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-field pl-9 py-1.5 text-xs rounded-xl"
              />
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Priority Filter */}
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="bg-slate-900 border border-slate-800 text-slate-300 text-xs rounded-xl px-3 py-1.5 outline-none cursor-pointer"
            >
              <option value="all">Priority: All</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            {/* Total count badge */}
            <div className="text-xs text-slate-400 font-medium px-2.5 py-1 rounded-xl bg-slate-900 border border-slate-800">
              {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
            </div>
          </div>
        </div>
      </div>

      {/* Offline & Sync Status Banner */}
      {!isOnline && (
        <div className="mx-6 mt-3 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-300">
          <div className="flex items-center gap-2">
            <CloudOff className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Offline Mode Active:</strong> You can continue creating, moving, and editing tasks. All changes are saved locally and will auto-sync once connection returns.
            </span>
          </div>
          {pendingCount > 0 && (
            <span className="font-semibold bg-amber-500/20 px-2.5 py-0.5 rounded border border-amber-500/30">
              {pendingCount} change{pendingCount > 1 ? 's' : ''} queued
            </span>
          )}
        </div>
      )}

      {isOnline && pendingCount > 0 && (
        <div className="mx-6 mt-3 px-4 py-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-between text-xs text-indigo-300">
          <div className="flex items-center gap-2">
            <RefreshCw className={`w-4 h-4 text-indigo-400 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>
              {isSyncing
                ? `Synchronizing ${pendingCount} offline change(s) with server...`
                : `You have ${pendingCount} offline change(s) queued for synchronization.`}
            </span>
          </div>
          {!isSyncing && (
            <button
              onClick={processSyncQueue}
              className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer shadow-sm transition-all"
            >
              Sync Now
            </button>
          )}
        </div>
      )}

      {conflictsCount > 0 && (
        <div className="mx-6 mt-3 px-4 py-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 flex items-center justify-between text-xs text-rose-300">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>
              <strong>Sync Conflict:</strong> {conflictsCount} task{conflictsCount > 1 ? 's were' : ' was'} updated by another user on the server while you were offline.
            </span>
          </div>
          <button
            onClick={() => setShowConflictModal(true)}
            className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-medium cursor-pointer shadow-sm transition-all"
          >
            Review & Resolve
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-6 pt-4">
        {viewMode === 'kanban' ? (
          /* Kanban Columns */
          <div className="flex gap-4 h-full items-start pb-4">
            {COLUMNS.map((col) => {
              const colTasks = tasks.filter((t) => t.status === col.id);
              const isOver = dragOverColumn === col.id;
              const Icon = col.icon;

              return (
                <div
                  key={col.id}
                  className="kanban-column flex-1 flex flex-col h-full rounded-2xl bg-slate-900/40 border border-slate-800/80 shadow-md"
                >
                  {/* Column Header */}
                  <div className="p-3.5 border-b border-slate-800/80 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="w-4 h-4" style={{ color: col.color }} />
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                        {col.title}
                      </span>
                    </div>
                    <span className="text-[11px] font-semibold text-slate-400 px-2 py-0.5 rounded-full bg-slate-800/80 border border-slate-700/60">
                      {colTasks.length}
                    </span>
                  </div>

                  {/* Drop Zone */}
                  <div
                    onDragOver={(e) => handleDragOver(e, col.id)}
                    onDragLeave={(e) => handleDragLeave(e, col.id)}
                    onDrop={(e) => handleDrop(e, col.id)}
                    className={`kanban-drop-zone flex-1 overflow-y-auto p-3 space-y-2.5 ${
                      isOver ? 'drag-over' : ''
                    }`}
                  >
                    {colTasks.map((task) => (
                      <TaskCard
                        key={task._id}
                        task={task}
                        onSelectTask={onSelectTask}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                      />
                    ))}

                    {colTasks.length === 0 && (
                      <div className="h-28 border border-dashed border-slate-800/90 rounded-xl flex items-center justify-center text-xs text-slate-400 select-none">
                        Drop tasks here
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* List / Table View Mode */
          <div className="glass-panel rounded-2xl overflow-hidden border border-slate-800">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Title</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Priority</th>
                    <th className="px-4 py-3">Assignee</th>
                    <th className="px-4 py-3">Due Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {tasks.map((task) => (
                    <tr
                      key={task._id}
                      onClick={() => onSelectTask(task)}
                      className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-slate-200">
                        {task.title}
                      </td>
                      <td className="px-4 py-3">
                        <span className="capitalize px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px]">
                          {task.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`badge badge-${task.priority}`}>
                          {task.priority}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {task.assignee ? task.assignee.name : 'Unassigned'}
                      </td>
                      <td className="px-4 py-3 text-slate-400">
                        {task.dueDate
                          ? new Date(task.dueDate).toLocaleDateString()
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Conflict Resolution Modal */}
      <ConflictModal
        isOpen={showConflictModal}
        onClose={() => setShowConflictModal(false)}
      />
    </div>
  );
};

export default KanbanBoard;
