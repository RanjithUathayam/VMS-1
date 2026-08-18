import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VendorEntryComponent } from './components/vendor-entry/vendor-entry.component';
import { WarehouseApprovalComponent } from './components/warehouse-approval/warehouse-approval.component';
import { GateEntryComponent } from './components/gate-entry/gate-entry.component';
import { LoginComponent } from './components/login/login.component';
import { AuthService } from './services/auth.service';
import { DashboardComponent } from './components/dashboard/dashboard';
import { PartyBinMasterComponent } from './components/party-bin-master/party-bin-master.component';
import { GrnPushingComponent } from './components/grn-pushing/grn-pushing.component';
import { JoStatusComponent } from './components/jo-status/jo-status.component';
import { JoVendorNavigationService } from './services/jo-vendor-navigation.service';
import { UserManagementComponent } from './components/user-management/user-management.component';

declare const Swal: any;

type View = 'dashBoard' | 'vendor' | 'warehouse' | 'gate' | 'partyBinMaster' | 'grnPushing' | 'joStatus' | 'userManagement';

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, LoginComponent, VendorEntryComponent, WarehouseApprovalComponent,
    GateEntryComponent, DashboardComponent, PartyBinMasterComponent, GrnPushingComponent,
    JoStatusComponent, UserManagementComponent,
  ],
})
export class AppComponent {
  authService = inject(AuthService);
  joVendorNav = inject(JoVendorNavigationService);

  currentUser   = this.authService.currentUser;
  activeView    = signal<View>('dashBoard');
  isSidebarOpen = signal(false);

  // ── Permission-based nav guards ──────────────────────────
  canSeeVendor          = computed(() => this.authService.hasPermission('vendor'));
  canSeeWarehouse       = computed(() => this.authService.hasPermission('warehouse'));
  canSeeGate            = computed(() => this.authService.hasPermission('gate'));
  canSeeDashBoard       = computed(() => this.authService.hasPermission('dashBoard'));
  canSeePartyBinMaster  = computed(() => this.authService.hasPermission('partyBinMaster'));
  canSeeGrnPushing      = computed(() => this.authService.hasPermission('grnPushing'));
  canSeeJoStatus        = computed(() => this.authService.hasPermission('joStatus'));
  canSeeUserManagement  = computed(() => this.authService.hasPermission('userManagement'));

  // ── Change Password modal ────────────────────────────────
  showChangePwd     = signal(false);
  changePwdForm     = signal({ current: '', newPwd: '', confirm: '' });
  changePwdError    = signal('');
  isChangingPwd     = signal(false);
  showChangePwdEye  = signal(false);

  constructor() {
    // Navigate to first permitted screen after login
    effect(() => {
      const user = this.currentUser();
      if (!user) return;
      const priority: View[] = [
        'vendor', 'dashBoard', 'joStatus', 'warehouse',
        'gate', 'partyBinMaster', 'grnPushing', 'userManagement',
      ];
      const first = priority.find(v => this.authService.hasPermission(v));
      if (first) this.setView(first);
    }, { allowSignalWrites: true });

    // Navigate to Vendor Entry when JO Status requests it
    effect(() => {
      const req = this.joVendorNav.navigationRequested();
      if (req > 0) this.setView('vendor');
    }, { allowSignalWrites: true });
  }

  setView(view: View): void {
    this.activeView.set(view);
    this.isSidebarOpen.set(false);
  }

  toggleSidebar(): void {
    this.isSidebarOpen.update(v => !v);
  }

  // ── Change Password ──────────────────────────────────────
  openChangePwd(): void {
    this.changePwdForm.set({ current: '', newPwd: '', confirm: '' });
    this.changePwdError.set('');
    this.showChangePwdEye.set(false);
    this.showChangePwd.set(true);
  }

  closeChangePwd(): void {
    this.showChangePwd.set(false);
  }

  setChangePwdField(field: 'current' | 'newPwd' | 'confirm', val: string): void {
    this.changePwdForm.update(f => ({ ...f, [field]: val }));
  }

  async submitChangePassword(): Promise<void> {
    const f = this.changePwdForm();
    if (!f.current) { this.changePwdError.set('Current password is required.'); return; }
    if (!f.newPwd || f.newPwd.length < 4) { this.changePwdError.set('New password must be at least 4 characters.'); return; }
    if (f.newPwd !== f.confirm) { this.changePwdError.set('Passwords do not match.'); return; }

    const username = this.currentUser()?.username;
    if (!username) { this.changePwdError.set('Could not identify current user.'); return; }

    this.isChangingPwd.set(true);
    this.changePwdError.set('');
    const result = await this.authService.changePassword(username, f.current, f.newPwd);
    this.isChangingPwd.set(false);

    if (result.success) {
      this.closeChangePwd();
      Swal.fire({ icon: 'success', title: 'Password Changed', text: 'Your password has been updated successfully.' });
    } else {
      this.changePwdError.set(result.message);
    }
  }

  logout(): void {
    this.authService.logout();
  }
}
