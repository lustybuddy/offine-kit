import React, { useState } from 'react';
import { X, Plus, Calendar, Tag, User, CloudOff } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useSync } from '../../context/SyncContext';
import offlineStorage from '../../services/offlineStorage';

const CreateTaskModal = ({ project, onClose, onTaskCreated, users }) => {
  const { user } = useAuth();
  const { isOnline, enqueueAction } = useSync();
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    status: 'todo',
    priority: 'medium',
    assignee: '',
    dueDate: '',
    tagsString: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleCreateOffline = (tags) => {
    const tempId = `temp_${Date.now()}`;
    const assignedUser = users?.find((u) => u._id === formData.assignee) || null;
    const tempTask = {
      _id: tempId,
      title: formData.title.trim(),
      description: formData.description.trim(),
      status: formData.status,
      priority: formData.priority,
      assignee: assignedUser,
      creator: user,
      project: project._id,
      dueDate: formData.dueDate || null,
      tags,
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _isOffline: true,
      _syncPending: true,
    };

    // Cache locally
    const cachedTasks = offlineStorage.getStoredTasks(project._id);
    offlineStorage.saveStoredTasks(project._id, [tempTask, ...cachedTasks]);

    // Queue for sync
    enqueueAction({
      type: 'CREATE_TASK',
      projectId: project._id,
      tempId,
      taskTitle: tempTask.title,
      payload: {
        title: tempTask.title,
        description: tempTask.description,
        status: tempTask.status,
        priority: tempTask.priority,
        assignee: formData.assignee || null,
        dueDate: tempTask.dueDate,
        tags: tempTask.tags,
      },
    });

    onTaskCreated(tempTask);
    onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.title.trim()) {
      setError('Task title is required');
      return;
    }

    setLoading(true);
    setError('');

    const tags = formData.tagsString
      ? formData.tagsString.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    if (!navigator.onLine) {
      handleCreateOffline(tags);
      setLoading(false);
      return;
    }

    try {
      const res = await api.post(`/projects/${project._id}/tasks`, {
        title: formData.title.trim(),
        description: formData.description.trim(),
        status: formData.status,
        priority: formData.priority,
        assignee: formData.assignee || null,
        dueDate: formData.dueDate || null,
        tags,
      });

      if (res.data.success) {
        // Cache task locally
        const cached = offlineStorage.getStoredTasks(project._id);
        offlineStorage.saveStoredTasks(project._id, [res.data.data, ...cached]);
        onTaskCreated(res.data.data);
        onClose();
      }
    } catch (err) {
      if (!err.response || err.code === 'ERR_NETWORK') {
        // Network failure: fallback to offline creation
        console.warn('Network issue while creating task, switching to offline queue.');
        handleCreateOffline(tags);
      } else {
        console.error('Failed to create task:', err);
        setError(err.response?.data?.message || 'Error creating task');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content p-6 space-y-5 max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400">
              <Plus className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Create New Task</h3>
              <p className="text-xs text-slate-400">
                in <span className="font-semibold text-slate-300">{project.name}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Task Title *
            </label>
            <input
              type="text"
              name="title"
              required
              value={formData.title}
              onChange={handleChange}
              placeholder="e.g. Implement webhook idempotency retry"
              className="input-field text-xs py-2"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Initial Column
              </label>
              <select
                name="status"
                value={formData.status}
                onChange={handleChange}
                className="input-field text-xs py-2"
              >
                <option value="todo">To Do</option>
                <option value="in-progress">In Progress</option>
                <option value="in-review">In Review</option>
                <option value="done">Done</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Priority
              </label>
              <select
                name="priority"
                value={formData.priority}
                onChange={handleChange}
                className="input-field text-xs py-2"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Assignee
              </label>
              <select
                name="assignee"
                value={formData.assignee}
                onChange={handleChange}
                className="input-field text-xs py-2"
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Due Date
              </label>
              <input
                type="date"
                name="dueDate"
                value={formData.dueDate}
                onChange={handleChange}
                className="input-field text-xs py-2"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Tags (comma-separated)
            </label>
            <input
              type="text"
              name="tagsString"
              value={formData.tagsString}
              onChange={handleChange}
              placeholder="Backend, API, High-Impact"
              className="input-field text-xs py-2"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Description
            </label>
            <textarea
              name="description"
              rows={3}
              value={formData.description}
              onChange={handleChange}
              placeholder="What needs to be accomplished and verified?"
              className="input-field text-xs py-2"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary text-xs py-2 px-3.5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary text-xs py-2 px-4"
            >
              {loading ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateTaskModal;
