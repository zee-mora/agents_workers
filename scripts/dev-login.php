<?php
// Dijalankan via: php artisan tinker --execute="require '<path ini>';"
// Idempotent: buat/update akun dev lokal untuk login screenshot. Hanya mengisi kolom yang ada.
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Schema;

$email = 'dev-shot@local.test';
$password = 'DevShot#2026!';
$table = (new App\Models\User)->getTable();
$vals = [
    'name' => 'devshot', 'fullname' => 'Dev Shot', 'username' => 'devshot', 'nickname' => 'devshot',
    'password' => Hash::make($password), 'status' => 1, 'is_active' => 1, 'is_admin' => 1,
    'can_switch_roles' => 1, 'email_verified_at' => now(),
];
$attrs = ['email' => $email];
foreach ($vals as $k => $v) if (Schema::hasColumn($table, $k)) $attrs[$k] = $v;

$user = App\Models\User::withoutGlobalScopes()->firstOrNew(['email' => $email]);
$user->forceFill($attrs)->save();
if (method_exists($user, 'trashed') && $user->trashed()) $user->restore();

if (class_exists(Spatie\Permission\Models\Role::class) && method_exists($user, 'syncRoles')) {
    app()[Spatie\Permission\PermissionRegistrar::class]->forgetCachedPermissions();
    $role = Spatie\Permission\Models\Role::firstOrCreate(['name' => 'developer', 'guard_name' => 'web']);
    $role->syncPermissions(Spatie\Permission\Models\Permission::where('guard_name', 'web')->get());
    $user->syncRoles([$role]);
}
echo "dev-login ok\n";
