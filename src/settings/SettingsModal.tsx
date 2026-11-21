import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LANGS, type Lang } from '../../shared/i18n';
import type { ModelInstallInfo, ModelSource, Settings } from '../../shared/types';
import { openDownloads } from '../models/actions';
import { SourcePicker } from '../models/DownloadsModal';
import { Dropdown } from '../components/Dropdown';
import { api } from '../lib/api';
import { setComposer, toast, useStore } from '../store';

const DEEPSEEK_URL = 'https://api.deepseek.com';
const AGENT_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
import { lang, rememberLang, rich, t } from '../i18n';
import { Modal } from '../components/Modal';

const close = () => useStore.setState({ modal: null });

export function SettingsModal() {
  const workflows = useStore((s) => s.workflows);
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState('');
  const [commercial, setCommercial] = useState(false);
  const [agentModel, setAgentModel] = useState('');
  const [agentBaseUrl, setAgentBaseUrl] = useState('');
  const [agentApiKey, setAgentApiKey] = useState('');
  const [agentKeyConfigured, setAgentKeyConfigured] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | 'license' | 'agent' | 'models' | null>(null);
  const [install, setInstall] = useState<ModelInstallInfo | null>(null);
  const [modelSource, setModelSource] = useState<ModelSource>('auto');
  const [modelEndpoint, setModelEndpoint] = useState('');
  const [hfToken, setHfToken] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const showAgent = (s: Settings) => {
    setAgentModel((s.agentModel ?? '').replace(/^deepseek\//, '') || AGENT_MODELS[0]);
    setAgentBaseUrl(s.agentBaseUrl || DEEPSEEK_URL);
    setAgentKeyConfigured(Boolean(s.agentApiKeyConfigured));
  };

  useEffect(() => {
    void api.settings().then((s) => {
      setUrl(s.comfyUrl);
      setSaved(s.comfyUrl);
      setCommercial(Boolean(s.commercialOnly));
      showAgent(s);
    });
    void loadInstall();
  }, []);

  const loadInstall = async () => {
    try {
      const info = await api.modelInstall();
      setInstall(info);
      setModelSource(info.source);
      setModelEndpoint(info.endpoint ?? '');
    } catch {
      /* server offline */
    }
  };

  const saveModels = async (patch: { modelSource?: ModelSource; modelEndpoint?: string; hfToken?: string; clearHfToken?: boolean }) => {
    setBusy('models');
    try {
      await api.saveSettings(patch);
      setHfToken('');
      await loadInstall();
      toast(t('下载设置已保存'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const pickSource = (source: ModelSource) => {
    setModelSource(source);
    // A custom endpoint is saved with its address below.
    if (source !== 'custom') void saveModels({ modelSource: source });
  };

  const switchCommercial = async (on: boolean) => {
    setBusy('license');
    setCommercial(on);
    try {
      const r = await api.saveSettings({ commercialOnly: on });
      useStore.setState({ caps: r.capabilities, comfyOnline: r.capabilities.comfyOnline });
      setCommercial(Boolean(r.settings.commercialOnly));
      // Research-only Qwen-Image 2.1 is off now: start new images with Z-Image Turbo instead.
      if (on && useStore.getState().composer.imageModel === 'qwen') setComposer({ imageModel: 'zimage' });
      toast(on ? t('已开启：不能商用的模型已停用') : t('已关闭：所有模型都可以用，许可证由你自己负责'), 'success');
    } catch (err) {
      setCommercial(!on);
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      const r = await api.testComfy(url);
      setResult(r.ok ? { ok: true, text: t('连接成功 · ComfyUI {version} · {gpu}', { version: r.version ?? '', gpu: r.gpu ?? '' }) } : { ok: false, text: r.error ?? t('连接失败') });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const r = await api.saveSettings({ comfyUrl: url });
      useStore.setState({ caps: r.capabilities, comfyOnline: r.capabilities.comfyOnline });
      setUrl(r.settings.comfyUrl);
      setSaved(r.settings.comfyUrl);
      setResult(r.capabilities.comfyOnline ? { ok: true, text: t('已保存并连接') } : { ok: false, text: t('已保存，但现在连不上这个地址') });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const switchLang = async (next: Lang) => {
    rememberLang(next);
    await api.saveSettings({ language: next }).catch(() => {});
    location.reload();
  };

  /** Changes apply as soon as they are made; a text field saves when it loses focus. */
  const saveAgent = async (patch: Parameters<typeof api.saveSettings>[0]) => {
    setBusy('agent');
    try {
      const r = await api.saveSettings(patch);
      showAgent(r.settings);
      setAgentApiKey('');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const modelBase = () => agentBaseUrl.trim() || DEEPSEEK_URL;
  const pickAgentModel = (id: string) => {
    setAgentModel(id);
    void saveAgent({ agentModel: id, agentBaseUrl: modelBase(), agentReasoning: true });
  };
  const commitAgentBase = () => {
    setAgentBaseUrl(modelBase());
    void saveAgent({ agentBaseUrl: modelBase(), agentModel: agentModel || AGENT_MODELS[0] });
  };
  const commitAgentKey = () => {
    if (!agentApiKey.trim()) return;
    void saveAgent({ agentApiKey: agentApiKey.trim(), agentBaseUrl: modelBase(), agentModel: agentModel || AGENT_MODELS[0] });
  };

  return (
    <Modal title={t('设置')} onClose={close}>
      <section className="m-section">
        <div className="m-label">{t('界面语言')}</div>
        <div className="seg">
          {LANGS.map((l) => (
            <button key={l.id} className={l.id === lang ? 'on' : ''} onClick={() => l.id !== lang && void switchLang(l.id)}>
              {l.name}
            </button>
          ))}
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('ComfyUI 地址')}</div>
        <div className="m-row">
          <input
            className="m-input"
            value={url}
            placeholder="http://127.0.0.1:8188"
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value);
              setResult(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
          <button className="btn ghost" onClick={() => void test()} disabled={!url.trim() || busy !== null}>
            {busy === 'test' ? <Loader2 className="spin" /> : null}{t('测试')}
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={!url.trim() || busy !== null || url === saved}>
            {busy === 'save' ? <Loader2 className="spin" /> : null}{t('保存')}
          </button>
        </div>
        {result && <div className={`m-result ${result.ok ? 'ok' : 'bad'}`}>{result.text}</div>}
        <div className="m-help">
          {rich(t('ComfyUI 在本机：填 {0}。在局域网或服务器上：ComfyUI 启动时加 {1} 后填它的地址，或者用 SSH 隧道把端口转到本机（在 {2} 里设置 {3}，{4} 会自动建隧道）。'), [
            <code>http://127.0.0.1:8188</code>,
            <code>--listen</code>,
            <code>.env</code>,
            <code>SSH_HOST</code>,
            <code>npm run dev</code>,
          ])}
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('Agent')}</div>
        <div className="cfg">
          <label className="cfg-row">
            <span className="cfg-key">{t('Base URL')}</span>
            <input
              className="cfg-input"
              value={agentBaseUrl}
              placeholder={DEEPSEEK_URL}
              spellCheck={false}
              disabled={busy === 'agent'}
              onChange={(e) => setAgentBaseUrl(e.target.value)}
              onBlur={commitAgentBase}
              onKeyDown={(e) => e.key === 'Enter' && commitAgentBase()}
            />
          </label>
          <label className="cfg-row">
            <span className="cfg-key">{t('API key')}</span>
            <input
              className="cfg-input"
              type="password"
              value={agentApiKey}
              placeholder={agentKeyConfigured ? t('已配置，留空保持不变') : 'sk-…'}
              autoComplete="off"
              disabled={busy === 'agent'}
              onChange={(e) => setAgentApiKey(e.target.value)}
              onBlur={commitAgentKey}
              onKeyDown={(e) => e.key === 'Enter' && commitAgentKey()}
            />
            {agentKeyConfigured && <button className="cfg-clear" disabled={busy === 'agent'} onClick={() => void saveAgent({ clearAgentApiKey: true })}>{t('清除')}</button>}
          </label>
          <div className="cfg-row">
            <span className="cfg-key">{t('模型')}</span>
            <span className="cfg-dd">
              <Dropdown
                value={agentModel}
                options={[
                  ...(!AGENT_MODELS.includes(agentModel) ? [{ value: agentModel, label: agentModel }] : []),
                  ...AGENT_MODELS.map((m) => ({ value: m, label: m })),
                ]}
                onChange={pickAgentModel}
              />
            </span>
          </div>
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">
          {t('模型下载')}
          <button className="btn ghost small dl-link" onClick={() => openDownloads([])}>{t('下载记录')}</button>
        </div>
        <div className="m-row dl-source">
          <span className="m-help">{t('下载源')}</span>
          <SourcePicker value={modelSource} endpoint={modelSource === 'custom' ? 'custom' : install?.endpoint} onChange={pickSource} disabled={busy !== null} />
        </div>
        {modelSource === 'custom' && (
          <div className="m-row">
            <input className="m-input" value={modelEndpoint} placeholder={t('https://hf.example.com（兼容 Hugging Face 的镜像地址）')} spellCheck={false} onChange={(e) => setModelEndpoint(e.target.value)} />
            <button className="btn primary" disabled={!modelEndpoint.trim() || busy !== null} onClick={() => void saveModels({ modelSource: 'custom', modelEndpoint })}>
              {busy === 'models' ? <Loader2 className="spin" /> : null}{t('保存')}
            </button>
          </div>
        )}
        <div className="m-row">
          <input
            className="m-input"
            type="password"
            value={hfToken}
            placeholder={install?.hfTokenConfigured ? t('Hugging Face token 已配置，留空保持不变') : t('Hugging Face token（下载需要申请的模型时才用，可留空）')}
            autoComplete="off"
            onChange={(e) => setHfToken(e.target.value)}
          />
          <button className="btn ghost" disabled={!hfToken.trim() || busy !== null} onClick={() => void saveModels({ hfToken })}>{t('保存 token')}</button>
          {install?.hfTokenConfigured && <button className="btn ghost" disabled={busy !== null} onClick={() => void saveModels({ clearHfToken: true })}>{t('清除')}</button>}
        </div>
      </section>

      <section className="m-section">
        <div className="m-label">{t('商用')}</div>
        <label className="m-check">
          <input type="checkbox" checked={commercial} disabled={busy !== null} onChange={(e) => void switchCommercial(e.target.checked)} />
          <span>{t('只用可以商用的模型')}</span>
        </label>
      </section>

      <section className="m-section">
        <div className="m-label">{t('我的工作流')}</div>
        <div className="m-row">
          <span className="m-help">{t('已导入 {n} 个', { n: workflows.length })}</span>
          <button className="btn ghost" onClick={() => useStore.setState({ modal: { type: 'workflows' } })}>
            {t('管理')}
          </button>
        </div>
      </section>
    </Modal>
  );
}
