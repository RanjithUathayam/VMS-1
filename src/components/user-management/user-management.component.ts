import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, computed, inject, signal, OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { UserManagementService, AppUser } from '../../services/user-management.service';
import { RoleManagementService, AppRole } from '../../services/role-management.service';
import { AuthService } from '../../services/auth.service';

declare const Swal: any;

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_META: Record<string, { label: string; color: string; bg: string }> = {
    admin:     { label: 'Administrator', color: '#6366f1', bg: '#ede9fe' },
    manager:   { label: 'Manager',       color: '#0891b2', bg: '#e0f2fe' },
    vendor:    { label: 'Vendor',        color: '#d97706', bg: '#fef3c7' },
    watchman:  { label: 'Watchman',      color: '#059669', bg: '#dcfce7' },
    inventory: { label: 'Inventory',     color: '#7c3aed', bg: '#f3e8ff' },
    operator:  { label: 'Operator',      color: '#64748b', bg: '#f1f5f9' },
};

const DEFAULT_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#84cc16','#f97316'];

export const ALL_SCREENS = [
    { key: 'dashBoard',       label: 'Dashboard' },
    { key: 'vendor',          label: 'Vendor Entry' },
    { key: 'warehouse',       label: 'Warehouse Approval' },
    { key: 'gate',            label: 'Gate Entry' },
    { key: 'partyBinMaster',  label: 'Party Bin Master' },
    { key: 'grnPushing',      label: 'GRN Pushing' },
    { key: 'joStatus',        label: 'JO Status' },
    { key: 'userManagement',  label: 'User Management' },
] as const;

// ─── Interfaces ───────────────────────────────────────────────────────────────

type FormMode = 'create' | 'edit';

interface UserForm {
    username:        string;
    fullName:        string;
    phoneNumber:     string;
    email:           string;
    password:        string;
    confirmPassword: string;
    role:            string;
    isActive:        boolean;
}

interface RoleForm {
    roleName:    string;
    displayName: string;
    description: string;
    permissions: string[];
}

const EMPTY_FORM: UserForm = {
    username: '', fullName: '', phoneNumber: '', email: '',
    password: '', confirmPassword: '', role: 'vendor', isActive: true,
};

const EMPTY_ROLE_FORM: RoleForm = {
    roleName: '', displayName: '', description: '', permissions: [],
};

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
    standalone: true,
    imports: [CommonModule],
    selector: 'user-management',
    templateUrl: './user-management.component.html',
    styleUrls: ['./user-management.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserManagementComponent implements OnInit {

    private userApi = inject(UserManagementService);
    private roleApi = inject(RoleManagementService);
    private auth    = inject(AuthService);
    private cdr     = inject(ChangeDetectorRef);

    currentUser = this.auth.currentUser;

    // ── Tabs ─────────────────────────────────────────────────
    activeTab = signal<'users' | 'roles'>('users');

    // ── User list state ───────────────────────────────────────
    users        = signal<AppUser[]>([]);
    isLoading    = signal(false);
    searchTerm   = signal('');
    roleFilter   = signal('');
    statusFilter = signal<'' | 'active' | 'inactive'>('');

    readonly roleMeta  = ROLE_META;
    readonly allScreens = ALL_SCREENS;

    filteredUsers = computed(() => {
        const term   = this.searchTerm().toLowerCase().trim();
        const role   = this.roleFilter();
        const status = this.statusFilter();
        return this.users().filter(u => {
            if (term && ![u.Username, u.FullName, u.Email].some(v => (v || '').toLowerCase().includes(term))) return false;
            if (role   && u.Role     !== role)            return false;
            if (status === 'active'   && !u.IsActive)     return false;
            if (status === 'inactive' &&  u.IsActive)     return false;
            return true;
        });
    });

    totalUsers    = computed(() => this.users().length);
    activeCount   = computed(() => this.users().filter(u =>  u.IsActive).length);
    inactiveCount = computed(() => this.users().filter(u => !u.IsActive).length);
    adminCount    = computed(() => this.users().filter(u => u.Role === 'admin').length);

    // ── User form state ───────────────────────────────────────
    showForm    = signal(false);
    formMode    = signal<FormMode>('create');
    editingId   = signal<number | null>(null);
    form        = signal<UserForm>({ ...EMPTY_FORM });
    formError   = signal('');
    isSaving    = signal(false);
    showPassword        = signal(false);
    showConfirmPassword = signal(false);

    formTitle = computed(() => this.formMode() === 'create' ? 'Create New User' : 'Edit User');

    // ── Password Reset modal ───────────────────────────────
    showResetModal    = signal(false);
    resetTargetUser   = signal<AppUser | null>(null);
    resetPassword     = signal('');
    resetConfirm      = signal('');
    isResetting       = signal(false);
    showResetPwd      = signal(false);

    // ── View User modal ────────────────────────────────────
    showViewModal = signal(false);
    viewUser      = signal<AppUser | null>(null);

    // ── Toggling ──────────────────────────────────────────
    togglingId = signal<number | null>(null);

    // ── Role list state ────────────────────────────────────
    appRoles       = signal<AppRole[]>([]);
    rolesLoading   = signal(false);
    roleSearchTerm = signal('');

    filteredRoles = computed(() => {
        const term = this.roleSearchTerm().toLowerCase().trim();
        if (!term) return this.appRoles();
        return this.appRoles().filter(r =>
            r.RoleName.toLowerCase().includes(term) ||
            r.DisplayName.toLowerCase().includes(term)
        );
    });

    // ── Role form state ────────────────────────────────────
    showRoleForm   = signal(false);
    roleFormMode   = signal<FormMode>('create');
    editingRoleId  = signal<number | null>(null);
    roleForm       = signal<RoleForm>({ ...EMPTY_ROLE_FORM });
    roleFormError  = signal('');
    isRoleSaving   = signal(false);
    deletingRoleId = signal<number | null>(null);

    roleFormTitle = computed(() => this.roleFormMode() === 'create' ? 'Create Role' : 'Edit Role');

    // ── Lifecycle ─────────────────────────────────────────
    ngOnInit(): void { this.loadUsers(); this.loadRoles(); }

    // ─── Load ─────────────────────────────────────────────

    async loadUsers(): Promise<void> {
        this.isLoading.set(true);
        this.cdr.markForCheck();
        try {
            const res: any = await this.userApi.listUsers();
            this.users.set(res?.data || []);
        } catch (err: any) {
            Swal.fire({ icon: 'error', title: 'Load Failed', text: err?.message });
        } finally {
            this.isLoading.set(false);
            this.cdr.markForCheck();
        }
    }

    async loadRoles(): Promise<void> {
        this.rolesLoading.set(true);
        this.cdr.markForCheck();
        try {
            const res: any = await this.roleApi.listRoles();
            this.appRoles.set(res?.data || []);
        } catch { /* silently skip – roles tab will show empty */ }
        finally {
            this.rolesLoading.set(false);
            this.cdr.markForCheck();
        }
    }

    refresh(): void { this.loadUsers(); this.loadRoles(); }

    // ─── User form ────────────────────────────────────────

    openCreateForm(): void {
        this.form.set({ ...EMPTY_FORM });
        this.formMode.set('create');
        this.editingId.set(null);
        this.formError.set('');
        this.showPassword.set(false);
        this.showConfirmPassword.set(false);
        this.showForm.set(true);
    }

    openEditForm(user: AppUser): void {
        this.form.set({
            username:        user.Username,
            fullName:        user.FullName,
            phoneNumber:     user.PhoneNumber || '',
            email:           user.Email       || '',
            password:        '',
            confirmPassword: '',
            role:            user.Role,
            isActive:        user.IsActive,
        });
        this.formMode.set('edit');
        this.editingId.set(user.Id);
        this.formError.set('');
        this.showForm.set(true);
    }

    closeForm(): void { this.showForm.set(false); this.formError.set(''); }

    setField<K extends keyof UserForm>(key: K, value: UserForm[K]): void {
        this.form.update(f => ({ ...f, [key]: value }));
    }

    private validateForm(): string {
        const f = this.form();
        if (!f.fullName.trim()) return 'Full Name is required.';
        if (!f.role) return 'Role is required.';
        if (this.formMode() === 'create') {
            if (!f.username.trim()) return 'Username is required.';
            if (!f.password) return 'Password is required.';
            if (f.password.length < 4) return 'Password must be at least 4 characters.';
            if (f.password !== f.confirmPassword) return 'Passwords do not match.';
        }
        return '';
    }

    async saveUser(): Promise<void> {
        const err = this.validateForm();
        if (err) { this.formError.set(err); return; }
        this.isSaving.set(true);
        this.formError.set('');
        this.cdr.markForCheck();
        const f = this.form();
        try {
            if (this.formMode() === 'create') {
                await this.userApi.createUser({
                    username: f.username.trim(), fullName: f.fullName.trim(),
                    phoneNumber: f.phoneNumber.trim(), email: f.email.trim(),
                    password: f.password, role: f.role, isActive: f.isActive,
                });
            } else {
                await this.userApi.updateUser(this.editingId()!, {
                    fullName: f.fullName.trim(), phoneNumber: f.phoneNumber.trim(),
                    email: f.email.trim(), role: f.role, isActive: f.isActive,
                });
            }
            this.closeForm();
            await this.loadUsers();
        } catch (e: any) {
            this.formError.set(e?.error?.message || e?.message || 'An error occurred.');
        } finally {
            this.isSaving.set(false);
            this.cdr.markForCheck();
        }
    }

    // ─── Toggle Active ────────────────────────────────────

    async toggleActive(user: AppUser): Promise<void> {
        const action = user.IsActive ? 'deactivate' : 'activate';
        const { isConfirmed } = await Swal.fire({
            icon: 'question',
            title: `${user.IsActive ? 'Deactivate' : 'Activate'} User?`,
            html: `<b>${user.FullName}</b> (${user.Username}) will be ${action}d.`,
            showCancelButton: true,
            confirmButtonText: user.IsActive ? 'Deactivate' : 'Activate',
            confirmButtonColor: user.IsActive ? '#ef4444' : '#10b981',
        });
        if (!isConfirmed) return;
        this.togglingId.set(user.Id);
        this.cdr.markForCheck();
        try {
            await this.userApi.toggleStatus(user.Id, !user.IsActive);
            await this.loadUsers();
        } catch (e: any) {
            Swal.fire({ icon: 'error', text: e?.error?.message || 'Failed to update status.' });
        } finally {
            this.togglingId.set(null);
            this.cdr.markForCheck();
        }
    }

    // ─── Reset Password modal ─────────────────────────────

    openResetModal(user: AppUser): void {
        this.resetTargetUser.set(user);
        this.resetPassword.set('');
        this.resetConfirm.set('');
        this.showResetPwd.set(false);
        this.showResetModal.set(true);
    }

    closeResetModal(): void { this.showResetModal.set(false); }

    async confirmResetPassword(): Promise<void> {
        const pwd  = this.resetPassword();
        const conf = this.resetConfirm();
        if (!pwd || pwd.length < 4) {
            Swal.fire({ icon: 'warning', text: 'Password must be at least 4 characters.' }); return;
        }
        if (pwd !== conf) {
            Swal.fire({ icon: 'warning', text: 'Passwords do not match.' }); return;
        }
        this.isResetting.set(true);
        this.cdr.markForCheck();
        try {
            await this.userApi.resetPassword(this.resetTargetUser()!.Id, pwd);
            Swal.fire({ icon: 'success', title: 'Password Reset', text: 'Password has been updated.' });
            this.closeResetModal();
        } catch (e: any) {
            Swal.fire({ icon: 'error', text: e?.error?.message || 'Failed to reset password.' });
        } finally {
            this.isResetting.set(false);
            this.cdr.markForCheck();
        }
    }

    // ─── View modal ───────────────────────────────────────

    openViewModal(user: AppUser): void { this.viewUser.set(user); this.showViewModal.set(true); }
    closeViewModal(): void { this.showViewModal.set(false); }

    // ─── Role form ────────────────────────────────────────

    openCreateRoleForm(): void {
        this.roleForm.set({ ...EMPTY_ROLE_FORM });
        this.roleFormMode.set('create');
        this.editingRoleId.set(null);
        this.roleFormError.set('');
        this.showRoleForm.set(true);
    }

    openEditRoleForm(role: AppRole): void {
        this.roleForm.set({
            roleName:    role.RoleName,
            displayName: role.DisplayName,
            description: role.Description || '',
            permissions: [...role.Permissions],
        });
        this.roleFormMode.set('edit');
        this.editingRoleId.set(role.Id);
        this.roleFormError.set('');
        this.showRoleForm.set(true);
    }

    closeRoleForm(): void { this.showRoleForm.set(false); this.roleFormError.set(''); }

    setRoleField<K extends keyof RoleForm>(key: K, value: RoleForm[K]): void {
        this.roleForm.update(f => ({ ...f, [key]: value }));
    }

    isPermissionSelected(screenKey: string): boolean {
        return this.roleForm().permissions.includes(screenKey);
    }

    togglePermission(screenKey: string): void {
        this.roleForm.update(f => {
            const perms = f.permissions.includes(screenKey)
                ? f.permissions.filter(p => p !== screenKey)
                : [...f.permissions, screenKey];
            return { ...f, permissions: perms };
        });
    }

    selectAllPermissions(): void {
        this.roleForm.update(f => ({ ...f, permissions: ALL_SCREENS.map(s => s.key) }));
    }

    clearAllPermissions(): void {
        this.roleForm.update(f => ({ ...f, permissions: [] }));
    }

    private validateRoleForm(): string {
        const f = this.roleForm();
        if (this.roleFormMode() === 'create' && !f.roleName.trim()) return 'Role Name is required.';
        if (!f.displayName.trim()) return 'Display Name is required.';
        return '';
    }

    async saveRole(): Promise<void> {
        const err = this.validateRoleForm();
        if (err) { this.roleFormError.set(err); return; }
        this.isRoleSaving.set(true);
        this.roleFormError.set('');
        this.cdr.markForCheck();
        const f = this.roleForm();
        try {
            if (this.roleFormMode() === 'create') {
                await this.roleApi.createRole({
                    roleName:    f.roleName.trim(),
                    displayName: f.displayName.trim(),
                    description: f.description.trim(),
                    permissions: f.permissions,
                });
            } else {
                await this.roleApi.updateRole(this.editingRoleId()!, {
                    displayName: f.displayName.trim(),
                    description: f.description.trim(),
                    permissions: f.permissions,
                });
            }
            this.closeRoleForm();
            await this.loadRoles();
        } catch (e: any) {
            this.roleFormError.set(e?.error?.message || e?.message || 'An error occurred.');
        } finally {
            this.isRoleSaving.set(false);
            this.cdr.markForCheck();
        }
    }

    async deleteRole(role: AppRole): Promise<void> {
        const { isConfirmed } = await Swal.fire({
            icon: 'warning', title: 'Delete Role?',
            html: `Role <b>${role.DisplayName}</b> will be permanently deleted.`,
            showCancelButton: true, confirmButtonText: 'Delete', confirmButtonColor: '#ef4444',
        });
        if (!isConfirmed) return;
        this.deletingRoleId.set(role.Id);
        this.cdr.markForCheck();
        try {
            await this.roleApi.deleteRole(role.Id);
            await this.loadRoles();
        } catch (e: any) {
            Swal.fire({ icon: 'error', text: e?.error?.message || 'Failed to delete role.' });
        } finally {
            this.deletingRoleId.set(null);
            this.cdr.markForCheck();
        }
    }

    // ─── Utility ──────────────────────────────────────────

    roleLabel(roleName: string): string {
        const loaded = this.appRoles().find(r => r.RoleName === roleName);
        return loaded?.DisplayName || ROLE_META[roleName]?.label || roleName;
    }

    roleColor(roleName: string): string { return ROLE_META[roleName]?.color || this.seedColor(roleName); }
    roleBg(roleName: string): string    { return ROLE_META[roleName]?.bg    || this.seedBg(roleName); }

    private seedColor(s: string): string {
        const i = s.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % DEFAULT_COLORS.length;
        return DEFAULT_COLORS[i];
    }
    private seedBg(s: string): string { return this.seedColor(s) + '22'; }

    screenLabel(key: string): string {
        return ALL_SCREENS.find(s => s.key === key)?.label || key;
    }

    setFilter(type: 'search' | 'role' | 'status', val: string): void {
        if (type === 'search') this.searchTerm.set(val);
        if (type === 'role')   this.roleFilter.set(val);
        if (type === 'status') this.statusFilter.set(val as any);
    }

    clearFilters(): void {
        this.searchTerm.set('');
        this.roleFilter.set('');
        this.statusFilter.set('');
    }

    availableRoles(): AppRole[] {
        return this.appRoles().length > 0 ? this.appRoles() : [];
    }

    rolePermissions(roleName: string): string[] {
        return this.appRoles().find(r => r.RoleName === roleName)?.Permissions || [];
    }

    usersWithRole(roleName: string): number {
        return this.users().filter(u => u.Role === roleName).length;
    }

    /** Safe accessor for viewUser inside @if block — avoids ! in Angular templates */
    vu(): AppUser { return this.viewUser() as AppUser; }
    /** Safe accessor for resetTargetUser inside @if block */
    ru(): AppUser { return this.resetTargetUser() as AppUser; }
}
