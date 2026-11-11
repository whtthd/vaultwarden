"""Exact, reviewable hooks for the upstream 2026.10.1 web-vault bundle."""

ORIGINAL_ASSET = "app/main.1176a28a68b7b4809391.js"
ORIGINAL_SHA256 = "5defb27621655bc05a54d042e32ce21d66dadd337b3bc60bc0cb49c234e441d1"
ORIGINAL_LAZY_ASSETS = {
    "397.140f77b7f5a3e6236b43.js": {
        "sha256": "c70e9e531e63c7321f38eafaa8082d96f04440889c555f4c2fe27c8952743bb8",
        "patches": [
            (
                'get searchPlaceholder(){var e;const t=this.activeFilter();return t.isDeleted?'
                '"searchTrash":t.cipherType===ui.gC.Login?"searchLogin":t.cipherType===ui.gC.Card?'
                '"searchCard":t.cipherType===ui.gC.BankAccount?"searchBankAccount":'
                't.cipherType===ui.gC.Identity?"searchIdentity":t.cipherType===ui.gC.SecureNote?'
                '"searchSecureNote":t.cipherType===ui.gC.SshKey?"searchSshKey":'
                't.cipherType===ui.gC.Passport?"searchPassport":t.cipherType===ui.gC.DriversLicense?'
                '"searchDriversLicense":(null===(e=t.selectedCollectionNode)||void 0===e?void 0:e.node)?'
                'this.vfo1TerminologyService.enabled()?"searchSharedFolder":"searchCollection":"searchVault"}',
                'get searchPlaceholder(){return"searchVault"}',
            ),
            (
                '("placeholder",E.i5U(1,2,"searchCollection","searchSharedFolder"))',
                '("placeholder",E.i5U(1,2,"searchVault","searchVault"))',
            ),
            (
                'this.ciphers$=(0,b.z)([this.allCiphers$,this.filter$,this.currentSearchText$,'
                'this.showCollectionAccessRestricted$,this.userId$,this.organizationId$]).pipe('
                '(0,pt.p)(([e,t])=>null!=e&&null!=t),(0,Ie.H)(e=>qi(this,[e],void 0,'
                'function*([e,t,i,n,o,s]){if(void 0===t.collectionId&&void 0===t.type)return[];'
                'if(n)return[];const r=(0,d.Jpj)(t);if(yield this.searchService.isSearchable(i)){'
                'return(yield this.searchService.searchCiphers(o,s,i,e)).filter(r)}return e.filter(r)}))',
                'this.vwSearchUserId$=this.userId$.pipe((0,He.$)(),'
                '(0,v.t)({bufferSize:1,refCount:!1})),'
                'this.ciphers$=(0,b.z)([this.allCiphers$,this.filter$,this.currentSearchText$,'
                'this.showCollectionAccessRestricted$,this.userId$,this.organizationId$,'
                'this.collectionService.nestedCollections$,this.accountService.activeAccount$,'
                'this.vwSearchUserId$]).pipe((0,pt.p)(([e,t])=>null!=e&&null!=t),'
                '(0,m.n)(([e,t,i,n,o,s,r,a,l])=>a?.id===o&&o===l?'
                'window.VaultwardenEnhancements.searchOrganizationVaultCiphers('
                'this,o,s,e,t,i,r,n,d.Jpj):Promise.resolve([]))',
            ),
            (
                '.subscribe(e=>this.router.navigate([],{queryParams:{search:Mt.A.isNullOrEmpty(e)?null:e}',
                '.subscribe(e=>window.VaultwardenEnhancements.searchMatchesInput(e)&&'
                'this.router.navigate([],{queryParams:{search:Mt.A.isNullOrEmpty(e)?null:e}',
            ),
            (
                'const l=(0,b.z)([this.nestedCollections$,n,s,this._addAccessStatus$,e,i]).pipe('
                '(0,pt.p)(([e,t])=>null!=e&&null!=t),(0,Ie.H)(e=>Yt(this,[e],void 0,'
                'function*([e,t,i,n,,o]){var s;if(t.collectionId===Te.I_||void 0===t.collectionId&&'
                'void 0!==t.type)return{collections:[],showAddAccessToggle:!1};let r=[];'
                'if(void 0===t.collectionId||t.collectionId===d.u8Z)r=e;else{'
                'const i=Qt.F.getTreeNodeObjectFromList(e,t.collectionId);'
                'r=null!==(s=null==i?void 0:i.children)&&void 0!==s?s:[]}let a=[];'
                'if(yield this.searchService.isSearchable(i)){const e=(0,_t.eO)(r);'
                'a=this.searchPipe.transform(e,i,e=>e.name,e=>e.id)}else a=r.map(e=>e.node);'
                'const l=!o.allowAdminAccessToAllCollectionItems&&o.canEditUnmanagedCollections&&'
                'a.some(e=>e.unmanaged);return n===Ot.AddAccess&&l&&(a=a.filter(e=>e.unmanaged)),'
                '{collections:a,showAddAccessToggle:l}}))',
                'this.vwSearchUserId$=e.pipe((0,He.$)(),(0,v.t)({bufferSize:1,refCount:!1}));'
                'const l=(0,b.z)([this.nestedCollections$,n,s,this._addAccessStatus$,e,i,'
                'this.accountService.activeAccount$,this.vwSearchUserId$]).pipe('
                '(0,pt.p)(([e,t])=>null!=e&&null!=t),(0,r.T)(([e,t,i,n,s,o,u,h])=>{'
                'if(u?.id!==s||s!==h||o.id!==t.organizationId)'
                'return{collections:[],showAddAccessToggle:!1};'
                'let a=window.VaultwardenEnhancements.searchVaultCollections(e,t,i,!0);'
                'const l=!o.allowAdminAccessToAllCollectionItems&&o.canEditUnmanagedCollections&&'
                'a.some(e=>e.unmanaged);return n===Ot.AddAccess&&l&&(a=a.filter(e=>e.unmanaged)),'
                '{collections:a,showAddAccessToggle:l}})',
            ),
        ],
    },
}
LOCAL_ORIGIN = (
    '(window.location.protocol==="https:"&&window.location.port==="8001"&&'
    '["127.0.0.1","localhost","[::1]"].includes(window.location.hostname))'
)
LOCAL_PATCHES = [
    (
        'case b.Lw.Never:return this.platformUtilsService.isDev();default:',
        'case b.Lw.Never:return this.platformUtilsService.isDev()||' + LOCAL_ORIGIN + ';default:',
    ),
    (
        'provide:Ue.G$,useClass:wa.g2,deps:[]',
        'provide:Ue.G$,useClass:' + LOCAL_ORIGIN + '?Fb:wa.g2,deps:[]',
    ),
]
ENHANCEMENT_PATCHES = [
    (
        'get searchPlaceholder(){var e,t;return this.activeFilter.isFavorites?"searchFavorites":'
        'this.activeFilter.isDeleted?"searchTrash":this.activeFilter.isArchived?"searchArchive":'
        'this.activeFilter.cipherType===nu.gC.Login?"searchLogin":'
        'this.activeFilter.cipherType===nu.gC.Card?"searchCard":'
        'this.activeFilter.cipherType===nu.gC.Identity?"searchIdentity":'
        'this.activeFilter.cipherType===nu.gC.SecureNote?"searchSecureNote":'
        'this.activeFilter.cipherType===nu.gC.SshKey?"searchSshKey":'
        'this.activeFilter.cipherType===nu.gC.BankAccount?"searchBankAccount":'
        'this.activeFilter.cipherType===nu.gC.Passport?"searchPassport":'
        'this.activeFilter.cipherType===nu.gC.DriversLicense?"searchDriversLicense":'
        '(null===(e=this.activeFilter.selectedFolderNode)||void 0===e?void 0:e.node)?'
        'this.vfo1TerminologyService.enabled()?"searchMyFolder":"searchFolder":'
        '(null===(t=this.activeFilter.selectedCollectionNode)||void 0===t?void 0:t.node)?'
        'this.vfo1TerminologyService.enabled()?"searchSharedFolder":"searchCollection":'
        '"MyVault"===this.activeFilter.organizationId?"searchMyVault":'
        'this.activeFilter.organizationId?"searchOrganization":"searchVault"}',
        'get searchPlaceholder(){return"searchVault"}',
    ),
    (
        'collectionQueryParams(e){const t=null!=e?e:null;return this.enabled()?'
        '{sharedFolderId:t,collectionId:null}:{collectionId:t,sharedFolderId:null}}',
        'collectionQueryParams(e){const t=null!=e?e:null;return this.enabled()?'
        '{sharedFolderId:t,collectionId:null,search:null}:{collectionId:t,sharedFolderId:null,search:null}}',
    ),
    (
        'this.previousRef=this.service.scrollableRef(),this.service.scrollableRef.set(this.ref)',
        'this.previousRef=this.service.scrollableRef(),this.service.scrollableRef.set(this.ref),'
        'window.VaultwardenEnhancements.registerScrollHost(this)',
    ),
    (
        'ngOnDestroy(){this.service.scrollableRef()===this.ref&&this.service.scrollableRef.set(this.previousRef)}',
        'ngOnDestroy(){window.VaultwardenEnhancements.unregisterScrollHost(this),'
        'this.service.scrollableRef()===this.ref&&this.service.scrollableRef.set(this.previousRef)}',
    ),
    (
        'static nestedTraverse(e,t,i,s,o,a){if(i.length<=t)return;',
        'static nestedTraverse(e,t,i,s,o,a){if(s.organizationId)return '
        'window.VaultwardenEnhancements.nestedCollectionTraverse(e,t,i,s,o,a,(e,t,i)=>new n.n(e,t,i));'
        'if(i.length<=t)return;',
    ),
    (
        'this.params.showOrgSelector&&this.showOrgSelector.set(!0),'
        'this.formGroup.patchValue({selectedOrg:this.params.organizationId},{emitEvent:!1}),this.organizationSelected',
        'this.params.showOrgSelector&&this.showOrgSelector.set(!0),'
        'this.formGroup.patchValue({selectedOrg:this.params.organizationId},{emitEvent:!1}),'
        'window.VaultwardenEnhancements.registerCollectionDialog(this),this.organizationSelected',
    ),
    (
        'this.collectionAdminService.update(c,u)',
        'window.VaultwardenEnhancements.saveCollection(this,c,u,v._)',
    ),
    (
        'this.collectionAdminService.create(c,u)',
        'window.VaultwardenEnhancements.createCollection(this,c,u,v._)',
    ),
    (
        'this.selectionList.formArray.disabled?t([]):t(e))})}registerOnChange(e)',
        'this.selectionList.formArray.disabled?t([]):t(e))}),'
        'window.VaultwardenEnhancements.registerMemberCollectionSelector(this,(0,r.WQX)(w.aKT).nativeElement)}'
        'ngOnDestroy(){window.VaultwardenEnhancements.unregisterMemberCollectionSelector(this)}registerOnChange(e)',
    ),
    (
        '93817(e,t,i){"use strict";i.d(t,{l:()=>qe});var n=i(15639)',
        '93817(e,t,i){"use strict";i.d(t,{l:()=>qe});var vwCollectionAdmin=i(21571).vE,n=i(15639)',
    ),
    (
        'this.permissionPriority=[y.aF.Manage,y.aF.Edit,y.aF.EditExceptPass,y.aF.View,y.aF.ViewExceptPass]}',
        'this.permissionPriority=[y.aF.Manage,y.aF.Edit,y.aF.EditExceptPass,y.aF.View,y.aF.ViewExceptPass],'
        'this.vwCollectionAdminService=(0,p.WQX)(vwCollectionAdmin)}',
    ),
    (
        'ngOnInit(){return K(this,void 0,void 0,function*(){null!=this.cipher.organizationId&&'
        '(this.organization=this.organizations.find(e=>e.id===this.cipher.organizationId))})}get showArchiveButton()',
        'ngOnInit(){return K(this,void 0,void 0,function*(){null!=this.cipher.organizationId&&'
        '(this.organization=this.organizations.find(e=>e.id===this.cipher.organizationId)),'
        'window.VaultwardenEnhancements.registerCipherRow(this,A._)})}'
        'ngOnDestroy(){window.VaultwardenEnhancements.unregisterCipherRow(this)}get showArchiveButton()',
    ),
    (
        'this.originalCipherView=yield this.addEditFormService.decryptCipher(this.config.originalCipher)',
        '"clone"===this.config.mode&&(this.config.originalCipher='
        'window.VaultwardenEnhancements.cloneSourceWithoutItemAccess(this.config.originalCipher)),'
        'this.originalCipherView=yield this.addEditFormService.decryptCipher(this.config.originalCipher)',
    ),
    (
        '"AllCollections"!==this.activeFilter.collectionId&&null!=this.activeFilter.collectionId?'
        'this.activeFilter.collectionId:null',
        '"AllCollections"!==this.activeFilter.collectionId&&null!=this.activeFilter.collectionId&&'
        '!this.activeFilter.collectionId.startsWith("vw-ancestor:")?this.activeFilter.collectionId:null',
    ),
    (
        '.subscribe(e=>this.router.navigate([],{queryParams:{search:Ui.A.isNullOrEmpty(e)?null:e}',
        '.subscribe(e=>window.VaultwardenEnhancements.searchMatchesInput(e)&&'
        'this.router.navigate([],{queryParams:{search:Ui.A.isNullOrEmpty(e)?null:e}',
    ),
    (
        'a=(0,Ke.z)([o,i,this.currentSearchText$]).pipe((0,h.p)(([e,t])=>null!=e&&null!=t),'
        '(0,Sl.H)(t=>RG(this,[t],void 0,function*([t,i,n]){var r;'
        'const s=null!==(r=yield(0,u._)(this.cipherService.failedToDecryptCiphers$(e)))&&void 0!==r?r:[],'
        'o=(0,Bh.Jpj)(i),a=[...s,...t];if(yield this.searchService.isSearchable(n)){'
        'return(yield this.searchService.searchCiphers(e,null,n,a)).filter(o)}return a.filter(o)}))',
        'a=(0,Ke.z)([o,i,this.currentSearchText$,r,this.accountService.activeAccount$]).pipe('
        '(0,h.p)(([e,t])=>null!=e&&null!=t),'
        '(0,Le.n)(([t,i,n,r,s])=>null!=s&&s.id===e?'
        'window.VaultwardenEnhancements.searchVaultCiphers(this,e,t,i,n,r,Bh.Jpj,u._):Promise.resolve([]))',
    ),
    (
        'l=(0,Ke.z)([r,i,this.currentSearchText$]).pipe((0,h.p)(([e,t])=>null!=e&&null!=t),'
        '(0,Sl.H)(e=>RG(this,[e],void 0,function*([e,t,i]){var n;if(void 0===t.collectionId||'
        't.collectionId===hc.I_)return[];let r=[];if(void 0!==t.organizationId&&'
        't.collectionId===Bh.u8Z)r=e.filter(e=>e.node.organizationId===t.organizationId);'
        'else if(t.collectionId===Bh.u8Z)r=e;else{const i=sG.F.getTreeNodeObjectFromList(e,t.collectionId);'
        'r=null!==(n=null==i?void 0:i.children)&&void 0!==n?n:[]}if(yield this.searchService.isSearchable(i)){'
        'const e=(0,nG.eO)(r);return this.searchPipe.transform(e,i,e=>e.name,e=>e.id)}return r.map(e=>e.node)}))',
        'l=(0,Ke.z)([r,i,this.currentSearchText$,this.accountService.activeAccount$]).pipe('
        '(0,h.p)(([e,t])=>null!=e&&null!=t),(0,g.T)(([t,i,n,r])=>r?.id===e?'
        'window.VaultwardenEnhancements.searchVaultCollections(t,i,n):[])',
    ),
]


def patch_lazy_bundle(original, asset):
    spec = ORIGINAL_LAZY_ASSETS[asset]
    patched = original
    for before, after in spec["patches"]:
        if patched.count(before.encode()) != 1:
            raise ValueError("Expected one supported lazy web-vault hook: " + before[:60])
        patched = patched.replace(before.encode(), after.encode(), 1)
    return patched


def patch_bundle(original, local_dev=False, lazy_assets=None):
    patched = original
    for before, after in ENHANCEMENT_PATCHES + (LOCAL_PATCHES if local_dev else []):
        if patched.count(before.encode()) != 1:
            raise ValueError("Expected one supported web-vault hook: " + before[:60])
        patched = patched.replace(before.encode(), after.encode(), 1)
    for original_name, generated_name in (lazy_assets or {}).items():
        # Webpack stores the chunk content hash in the main bundle's filename map.
        # Replace only the hash, preserving the numeric chunk id and extension.
        original_hash = original_name.removesuffix(".js").split(".")[1].encode()
        generated_hash = generated_name.removesuffix(".js").split(".")[1].encode()
        hook = b'"' + original_hash + b'"'
        replacement = b'"' + generated_hash + b'"'
        if patched.count(hook) != 1:
            raise ValueError("Expected one lazy chunk filename hook: " + original_name)
        patched = patched.replace(hook, replacement, 1)
    return patched
