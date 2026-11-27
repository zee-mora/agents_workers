<?php
// Dijalankan via: php artisan tinker --execute="require '<path ini>';"
// Cetak JSON {role: id user contoh|null} untuk prompt agent (pilihan `AS: role/user` saat screenshot). Read-only.
$skip = getenv('SHOT_LOGIN_USER') ?: '';
$out = [];
if (class_exists(Spatie\Permission\Models\Role::class)) {
    foreach (Spatie\Permission\Models\Role::where('guard_name', 'web')->orderBy('id')->limit(50)->get() as $role) {
        $out[$role->name] = App\Models\User::role($role->name)->where('email', '!=', $skip)->value('id');
    }
}
echo 'ROLES_JSON=' . json_encode($out) . "\n";
